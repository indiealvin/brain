/**
 * The replay engine's rules (implementation-plan T1.3), against a fake
 * in-process server, so they are pinned independently of `brain rpc`:
 * per-request-id ordering, notification windows (including the trailing
 * window), the advance rule, header filtering, polling types, steps.
 */
import { describe, expect, test } from "bun:test";
import { Substitutions } from "./harness/match";
import type { ServerHandle, ServerMessage } from "./harness/process";
import { replay } from "./harness/replay";
import { registerStep } from "./harness/steps";
import { parseTranscript, TranscriptError } from "./harness/transcript";

type Msg = Record<string, unknown>;

/** A scripted server: `react` gets every client message and answers through `emit`. */
class FakeServer implements ServerHandle {
  readonly received: Msg[] = [];
  readonly finished: Promise<number>;
  private exitWith!: (code: number) => void;
  private readonly listeners: ((msg: ServerMessage | null, raw: string) => void)[] = [];
  constructor(private readonly react: (msg: Msg, server: FakeServer) => void = () => {}) {
    this.finished = new Promise((r) => {
      this.exitWith = r;
    });
  }
  sendRaw(line: string): void {
    const msg = JSON.parse(line) as Msg;
    this.received.push(msg);
    queueMicrotask(() => this.react(msg, this));
  }
  onMessage(listener: (msg: ServerMessage | null, raw: string) => void): void {
    this.listeners.push(listener);
  }
  emit(msg: Msg, delayMs = 0): void {
    const send = () => {
      for (const l of this.listeners) l(msg, JSON.stringify(msg));
    };
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  }
  emitRaw(raw: string): void {
    for (const l of this.listeners) l(null, raw);
  }
  exit(code = 0, delayMs = 0): void {
    setTimeout(() => this.exitWith(code), delayMs);
  }
  stderrTail(): string {
    return "(fake server)";
  }
}

const result = (id: string | null, data: unknown = {}) => ({ id, type: "result", data });

function transcript(header: object, ...lines: object[]): string {
  return [header, ...lines].map((l) => JSON.stringify(l)).join("\n");
}
const c2s = (msg: Msg) => ({ dir: "c2s", msg });
const s2c = (msg: Msg, match?: object) => (match ? { dir: "s2c", msg, match } : { dir: "s2c", msg });
const step = (s: Msg) => ({ dir: "test", step: s });
const req = (id: string, method = "m", params: Msg = {}) => ({ id, method, params });
const NONE = { asserts: { notifications: [] } };

async function run(text: string, server: FakeServer, opts: { trailingMs?: number } = {}): Promise<void> {
  const t = parseTranscript(text, "fake.jsonl");
  await replay(t, { server, subs: new Substitutions(), tmp: "/tmp/fake", home: "/tmp/fake/home", state: new Map(), defer: () => {} }, { waitMs: 1500, trailingMs: opts.trailingMs ?? 50 });
}

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the replay to fail, but it passed");
}

describe("per request id", () => {
  test("messages of one id match in order; different ids interleave freely, and may arrive before later client lines", async () => {
    const text = transcript(NONE, c2s(req("a")), c2s(req("b")), s2c({ id: "a", type: "progress", data: { n: 1 } }), s2c(result("a", { n: 2 })), s2c(result("b")));
    // b answers first; a's event and result arrive later
    const server = new FakeServer((m, s) => {
      if (m["id"] === "a") {
        s.emit({ id: "a", type: "progress", data: { n: 1 } }, 30);
        s.emit(result("a", { n: 2 }), 60);
      } else s.emit(result("b"));
    });
    await run(text, server);
    // a's result arriving before b is even sent is fine too (b's line comes after a's lines only in file order)
    const early = new FakeServer((m, s) => {
      if (m["id"] === "a") {
        s.emit({ id: "a", type: "progress", data: { n: 1 } });
        s.emit(result("a", { n: 2 }));
      } else s.emit(result("b"));
    });
    await run(text, early);
  });

  test("a cancel result and the cancelled request's CANCELLED error can arrive either way round", async () => {
    const text = transcript(NONE, c2s(req("x")), c2s(req("c", "cancel", { target: "x" })), s2c({ id: "x", type: "error", error: { code: "CANCELLED", message: "m" } }), s2c(result("c", { cancelled: true })));
    for (const cancelFirst of [true, false]) {
      const server = new FakeServer((m, s) => {
        if (m["id"] !== "c") return;
        const cancelled = { id: "x", type: "error", error: { code: "CANCELLED", message: "m" } };
        const res = result("c", { cancelled: true });
        for (const msg of cancelFirst ? [res, cancelled] : [cancelled, res]) s.emit(msg);
      });
      await run(text, server);
    }
  });

  test("out of order within one id fails", async () => {
    const text = transcript(NONE, c2s(req("a")), s2c({ id: "a", type: "progress", data: {} }), s2c(result("a")));
    const server = new FakeServer((_, s) => {
      s.emit(result("a"));
      s.emit({ id: "a", type: "progress", data: {} });
    });
    expect(await failure(run(text, server))).toContain('line 3 (id "a") does not match at /type: expected "progress", got "result"');
  });

  test("a message for an id with nothing left to match fails, and so does a missing one (timeout)", async () => {
    const extra = new FakeServer((m, s) => {
      s.emit(result(String(m["id"])));
      s.emit(result(String(m["id"])));
    });
    expect(await failure(run(transcript(NONE, c2s(req("a")), s2c(result("a"))), extra))).toContain('unexpected message for id "a"');
    const silent = new FakeServer();
    expect(await failure(run(transcript(NONE, c2s(req("a")), s2c(result("a"))), silent))).toContain("timed out after 1500 ms waiting for line(s) 3");
  });

  test("id null is an id like any other (framing errors)", async () => {
    const err = { id: null, type: "error", error: { code: "INVALID_PARAMS", message: "x" } };
    const text = transcript(NONE, step({ op: "sendRaw", line: "{oops" }), s2c(err, { "/error/message": "<any>" }));
    const server = new FakeServer();
    server.sendRaw = function (line: string) {
      expect(line).toBe("{oops");
      this.emit({ ...err, error: { code: "INVALID_PARAMS", message: "different text" } });
    };
    await run(text, server);
  });
});

describe("notification windows", () => {
  const H = { asserts: { notifications: ["knowledge.event", "repo.changed"] } };
  const ev = (n: number) => ({ type: "knowledge.event", data: { n } });

  test("within a window notifications match as an unordered multiset; unlisted types are ignored", async () => {
    const text = transcript(H, c2s(req("a")), s2c(result("a")), s2c(ev(1)), s2c(ev(2)));
    const server = new FakeServer((_, s) => {
      s.emit({ type: "engine.humanSync", data: {} }); // not in the header: ignored
      s.emit(ev(2));
      s.emit(result("a"));
      s.emit(ev(1));
    });
    await run(text, server);
  });

  test("an asserted notification that matches nothing left in its window fails", async () => {
    const text = transcript(H, c2s(req("a")), s2c(result("a")), s2c(ev(1)));
    const twice = new FakeServer((_, s) => {
      s.emit(result("a"));
      s.emit(ev(1));
      s.emit(ev(1));
    });
    expect(await failure(run(text, twice))).toContain("unexpected knowledge.event notification in the window after line 2");
  });

  test("a notification that arrives in an earlier window than its line fails", async () => {
    const text = transcript(H, c2s(req("a")), s2c(result("a")), c2s(req("b")), s2c(result("b")), s2c(ev(1)));
    const early = new FakeServer((m, s) => {
      if (m["id"] === "a") s.emit(ev(1)); // belongs after b
      s.emit(result(String(m["id"])));
    });
    expect(await failure(run(text, early))).toContain("unexpected knowledge.event notification in the window after line 2");
  });

  test("polling types match at least once: extra and non-matching polls are accepted", async () => {
    const changed = (domains: string[]) => ({ type: "repo.changed", data: { domains, mainHead: "x" } });
    const text = transcript(H, c2s(req("a")), s2c(result("a")), s2c(changed(["git"]), { "/data/domains": { $contains: ["git"] } }));
    const server = new FakeServer((_, s) => {
      s.emit(changed(["queue"]));
      s.emit(result("a"));
      s.emit(changed(["index", "git"]));
      s.emit(changed(["git"]));
    });
    await run(text, server);
    // ... but at least one matching occurrence is required
    const none = new FakeServer((_, s) => {
      s.emit(result("a"));
      s.emit(changed(["queue"]));
    });
    expect(await failure(run(text, none))).toContain("timed out after 1500 ms waiting for line(s) 4");
    // a window expecting no poll accepts any number of them
    const noneExpected = transcript(H, c2s(req("a")), s2c(result("a")));
    await run(
      noneExpected,
      new FakeServer((_, s) => {
        s.emit(changed(["git"]));
        s.emit(changed(["git"]));
        s.emit(result("a"));
      }),
    );
  });

  test("advance rule: the next client line is sent only after the window's expected notifications matched", async () => {
    const text = transcript(H, c2s(req("a")), s2c(result("a")), s2c(ev(1)), c2s(req("b")), s2c(result("b")));
    let notified = false;
    const server = new FakeServer((m, s) => {
      if (m["id"] === "a") {
        s.emit(result("a"));
        setTimeout(() => {
          notified = true;
          s.emit(ev(1));
        }, 100);
      } else {
        expect(notified).toBe(true);
        s.emit(result("b"));
      }
    });
    await run(text, server);
    expect(server.received.map((m) => m["id"])).toEqual(["a", "b"]);
  });

  test("the trailing window catches notifications after the last client line: expected ones match, unexpected ones fail", async () => {
    const text = transcript(H, c2s(req("a")), s2c(result("a")), s2c(ev(1)));
    await run(
      text,
      new FakeServer((_, s) => {
        s.emit(result("a"));
        s.emit(ev(1), 50);
      }),
    );
    const extra = new FakeServer((_, s) => {
      s.emit(result("a"));
      s.emit(ev(1));
      s.emit(ev(2), 20); // after every expected line matched, still inside the trailing window
    });
    expect(await failure(run(text, extra, { trailingMs: 200 }))).toContain("unexpected knowledge.event notification");
  });

  test("after shutdown the trailing window lasts until the server exits, which must be with code 0", async () => {
    const text = transcript(H, c2s(req("s", "shutdown")), s2c(result("s")));
    const late = new FakeServer((_, s) => {
      s.emit(result("s"));
      s.emit(ev(9), 30); // before exit: still in the trailing window
      s.exit(0, 80);
    });
    expect(await failure(run(text, late))).toContain("unexpected knowledge.event notification");
    const clean = new FakeServer((_, s) => {
      s.emit(result("s"));
      s.exit(0, 30);
    });
    await run(text, clean);
    const crash = new FakeServer((_, s) => {
      s.emit(result("s"));
      s.exit(3, 10);
    });
    expect(await failure(run(text, crash))).toContain("exited with code 3 after shutdown");
  });

  test("a server that exits before the expected lines fails, naming them", async () => {
    const server = new FakeServer((_, s) => s.exit(1));
    expect(await failure(run(transcript(NONE, c2s(req("a")), s2c(result("a"))), server))).toContain("the server exited while waiting for line(s) 3");
  });

  test("a stdout line that is not a JSON object fails", async () => {
    const server = new FakeServer((_, s) => {
      s.emitRaw("hello from a library");
      s.emit(result("a"));
    });
    expect(await failure(run(transcript(NONE, c2s(req("a")), s2c(result("a"))), server))).toContain("stdout carried a line that is not a JSON object: hello from a library");
  });
});

describe("steps", () => {
  const calls: string[] = [];
  registerStep("replayTest.mark", (s, ctx) => {
    calls.push(String(s["label"]));
    ctx.alias("http://stub.recorded", "http://127.0.0.1:9");
  });

  test("a registered step runs at its position, after earlier lines matched; its alias rewrites later lines", async () => {
    calls.length = 0;
    const text = transcript(NONE, c2s(req("a")), s2c(result("a")), step({ op: "replayTest.mark", label: "one" }), c2s(req("b", "m", { url: "http://stub.recorded/x" })), s2c(result("b", { url: "http://stub.recorded/x" })));
    const server = new FakeServer((m, s) => {
      if (m["id"] === "a") setTimeout(() => s.emit(result("a")), 50);
      else s.emit(result("b", { url: (m["params"] as Msg)["url"] }));
    });
    await run(text, server);
    expect(calls).toEqual(["one"]);
    expect(server.received[1]).toEqual(req("b", "m", { url: "http://127.0.0.1:9/x" }));
  });

  test("expectPending fails when the request has already finished, and an unknown step fails", async () => {
    const done = new FakeServer((_, s) => s.emit(result("a")));
    expect(await failure(run(transcript(NONE, c2s(req("a")), step({ op: "expectPending", ids: ["a"], forMs: 50 }), s2c(result("a"))), done))).toContain("expectPending: a already received a terminal message");
    const pending = new FakeServer((_, s) => s.emit(result("a"), 200));
    await run(transcript(NONE, c2s(req("a")), step({ op: "expectPending", ids: ["a"], forMs: 50 }), s2c(result("a"))), pending);
    expect(await failure(run(transcript(NONE, step({ op: "no.such.step" })), new FakeServer()))).toContain('unknown transcript step "no.such.step"');
  });
});

describe("transcript lint", () => {
  test("header first; notification lines only of asserted types; match must fit its msg", () => {
    expect(() => parseTranscript(JSON.stringify(c2s(req("a"))), "t")).toThrow(TranscriptError);
    expect(() => parseTranscript(transcript(NONE, s2c({ type: "knowledge.event", data: {} })), "t")).toThrow("is not listed in the header");
    expect(() => parseTranscript(transcript(NONE, s2c(result("a"), { "/data/x": "<any>" })), "t")).toThrow("does not resolve inside msg");
    expect(() => parseTranscript(transcript(NONE, { dir: "sideways", msg: {} }), "t")).toThrow('dir must be "c2s", "s2c" or "test"');
    expect(parseTranscript(transcript(NONE, c2s(req("a")), s2c(result("a"))), "t").lines).toHaveLength(2);
  });
});
