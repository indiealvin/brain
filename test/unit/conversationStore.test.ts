import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isUlid } from "../../src/core/ids";
import { openConversationStore, turnUri, formatTurnId } from "../../src/conversation/store";

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "brain-conv-")), "conversations");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("conversation store (spec §4.5, §27; design §5)", () => {
  test("createSession returns a ULID and writes one JSONL file with a header", () => {
    const store = openConversationStore(dir);
    const s = store.createSession();
    expect(isUlid(s)).toBe(true);
    const raw = readFileSync(join(dir, `${s}.jsonl`), "utf8");
    const lines = raw.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    const header = JSON.parse(lines[0]!);
    expect(header.kind).toBe("session");
    expect(header.sessionId).toBe(s);
    expect(typeof header.createdAt).toBe("string");
    expect(store.hasSession(s)).toBe(true);
    expect(store.getTurns(s)).toEqual([]);
  });

  test("appendTurn numbers turns with zero-padded sequence ids and stable URIs", () => {
    const store = openConversationStore(dir);
    const s = store.createSession();
    const t1 = store.appendTurn(s, "user", "hello");
    const t2 = store.appendTurn(s, "assistant", "hi there");
    const t3 = store.appendTurn(s, "user", "yes");
    expect(t1).toEqual({ sessionId: s, turnId: "000001", role: "user", text: "hello" });
    expect(t2.turnId).toBe("000002");
    expect(t3.turnId).toBe("000003");
    expect(formatTurnId(42)).toBe("000042");
    expect(turnUri(t1)).toBe(`conversation://${s}/000001`);
    expect(store.getTurns(s)).toEqual([t1, t2, t3]);
    expect(store.lastTurns(s, 2)).toEqual([t2, t3]);
    expect(store.lastTurns(s, 10)).toEqual([t1, t2, t3]);
    expect(store.lastTurns(s, 0)).toEqual([]);
    // one JSON object per line, appended in order
    const lines = readFileSync(join(dir, `${s}.jsonl`), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[3]!)).toMatchObject({ kind: "turn", turnId: "000003", role: "user", text: "yes" });
  });

  test("a reopened store continues numbering from disk; torn trailing lines are ignored", () => {
    const a = openConversationStore(dir);
    const s = a.createSession();
    a.appendTurn(s, "user", "one");
    a.appendTurn(s, "assistant", "two");
    appendFileSync(join(dir, `${s}.jsonl`), '{"kind":"turn","turnId":"0000'); // crash mid-write
    const b = openConversationStore(dir);
    expect(b.getTurns(s).map((t) => t.turnId)).toEqual(["000001", "000002"]);
    const t3 = b.appendTurn(s, "user", "three");
    expect(t3.turnId).toBe("000003");
    expect(b.getTurns(s)).toHaveLength(3);
  });

  test("listSessions reports each session with its turn count, sorted by id; unknown ids are empty", () => {
    const store = openConversationStore(dir);
    const s1 = store.createSession();
    const s2 = store.createSession();
    store.appendTurn(s2, "user", "x");
    store.appendTurn(s2, "assistant", "y");
    const list = store.listSessions();
    expect(list.map((x) => x.sessionId)).toEqual([s1, s2].sort());
    expect(list.find((x) => x.sessionId === s1)!.turns).toBe(0);
    expect(list.find((x) => x.sessionId === s2)!.turns).toBe(2);
    for (const x of list) expect(x.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(store.getTurns("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toEqual([]);
    expect(store.getTurns("../evil")).toEqual([]);
    expect(store.hasSession("../evil")).toBe(false);
    expect(() => store.appendTurn("../evil", "user", "x")).toThrow(/invalid session id/);
    expect(() => store.appendTurn("01ARZ3NDEKTSV4RRFFQ69G5FAV", "user", "x")).toThrow(/unknown session/);
  });
});

describe("turn timestamps (CR-8)", () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  test("every appended turn reads back with its timestamp, in session order", () => {
    const store = openConversationStore(dir);
    const s = store.createSession();
    const before = new Date().toISOString();
    const t1 = store.appendTurn(s, "user", "hello");
    const t2 = store.appendTurn(s, "assistant", "hi there");
    const t3 = store.appendTurn(s, "user", "yes");
    const after = new Date().toISOString();

    const stored = store.getStoredTurns(s);
    expect(stored.map(({ at: _at, ...turn }) => turn)).toEqual([t1, t2, t3]);
    expect(stored.map(({ at: _at, ...turn }) => turn)).toEqual(store.getTurns(s));
    expect(stored.map((t) => t.turnId)).toEqual(["000001", "000002", "000003"]);
    for (const t of stored) {
      expect(t.at).toMatch(ISO);
      expect(t.at >= before).toBe(true);
      expect(t.at <= after).toBe(true);
    }
    // appends in one process never go back in time (equal within a millisecond is fine)
    expect(stored[1]!.at >= stored[0]!.at).toBe(true);
    expect(stored[2]!.at >= stored[1]!.at).toBe(true);

    // the timestamp is the one written to disk, not recomputed on read
    const lines = readFileSync(join(dir, `${s}.jsonl`), "utf8").trimEnd().split("\n").slice(1).map((l) => JSON.parse(l));
    expect(stored.map((t) => t.at)).toEqual(lines.map((l) => l.at));

    // a reopened store reads the same timestamps
    expect(openConversationStore(dir).getStoredTurns(s)).toEqual(stored);

    expect(store.getStoredTurns(store.createSession())).toEqual([]);
    expect(store.getStoredTurns("01ARZ3NDEKTSV4RRFFQ69G5FAV")).toEqual([]);
    expect(store.getStoredTurns("../evil")).toEqual([]);
  });

  test("an existing session file, which already stores `at`, reads back unchanged", () => {
    const s = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const file = join(dir, `${s}.jsonl`);
    const content =
      [
        `{"kind":"session","sessionId":"${s}","createdAt":"2026-05-01T09:00:00.000Z"}`,
        `{"kind":"turn","turnId":"000001","role":"user","text":"I prefer tea over coffee.","at":"2026-05-01T09:00:01.250Z"}`,
        `{"kind":"turn","turnId":"000002","role":"assistant","text":"Noted.","at":"2026-05-01T09:00:03.007Z"}`,
        `{"kind":"turn","turnId":"000003","role":"user","text":"Green tea, mostly.","at":"2026-05-02T18:30:00.000Z"}`,
      ].join("\n") + "\n";
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content);

    const store = openConversationStore(dir);
    expect(store.hasSession(s)).toBe(true);
    expect(store.getTurns(s)).toEqual([
      { sessionId: s, turnId: "000001", role: "user", text: "I prefer tea over coffee." },
      { sessionId: s, turnId: "000002", role: "assistant", text: "Noted." },
      { sessionId: s, turnId: "000003", role: "user", text: "Green tea, mostly." },
    ]);
    for (const t of store.getTurns(s)) expect("at" in t).toBe(false);
    expect(store.lastTurns(s, 1)).toEqual([{ sessionId: s, turnId: "000003", role: "user", text: "Green tea, mostly." }]);
    expect(store.getStoredTurns(s)).toEqual([
      { sessionId: s, turnId: "000001", role: "user", text: "I prefer tea over coffee.", at: "2026-05-01T09:00:01.250Z" },
      { sessionId: s, turnId: "000002", role: "assistant", text: "Noted.", at: "2026-05-01T09:00:03.007Z" },
      { sessionId: s, turnId: "000003", role: "user", text: "Green tea, mostly.", at: "2026-05-02T18:30:00.000Z" },
    ]);
    expect(store.listSessions()).toEqual([{ sessionId: s, createdAt: "2026-05-01T09:00:00.000Z", turns: 3 }]);
    // reading never rewrites the file
    expect(readFileSync(file, "utf8")).toBe(content);
  });
});
