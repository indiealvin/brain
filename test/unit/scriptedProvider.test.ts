/**
 * CR-6 (T0.2): the scripted model provider behind `BRAIN_MODEL_SCRIPT`.
 * Unit tests for dispatch, placeholders, hold/release, failures, consumption
 * and the call log, plus one `brain chat --once` run whose knowledge run
 * lands a CREATE mutation and an ARCHIVE proposal from the script.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrainConfig, ConversationTurn, ModelCompleteInput } from "../../src/core/types";
import { EXTRACTOR_SYSTEM_PROMPT, buildExtractorUserMessage } from "../../src/extract/prompts";
import { ModelProviderError } from "../../src/model/claude";
import type { PlannerInput } from "../../src/plan/context";
import { PLANNER_SYSTEM_PROMPT, buildPlannerUserMessage } from "../../src/plan/prompts";
import { CHAT_SYSTEM_PROMPT } from "../../src/pipeline/chat";
import { chunkWords } from "../../src/pipeline/mock";
import {
  ModelScriptProvider,
  createModelScriptProvider,
  defaultCallLogPath,
  loadModelScript,
  parseModelScript,
  turnsInCall,
  type ModelScript,
  type ScriptCallLogLine,
} from "../../src/pipeline/scripted";
import { commitAsHuman, fileAt, mutationIdsOn, revList, trailer, writeNote } from "../harness";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-script-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SESSION = "01KSESSION0000000000000000";
const turns: ConversationTurn[] = [
  { sessionId: SESSION, turnId: "000001", role: "user", text: "Reversible actions let an agent act with less pre-approval." },
  { sessionId: SESSION, turnId: "000002", role: "assistant", text: "So undo replaces approval." },
  { sessionId: SESSION, turnId: "000003", role: "user", text: "Cheap undo moves approval to after-the-fact review." },
  { sessionId: SESSION, turnId: "000004", role: "assistant", text: "Agreed." },
];

const chatCall = (content = "hello"): ModelCompleteInput => ({ system: CHAT_SYSTEM_PROMPT + "\n\n## Possibly relevant notes", messages: [{ role: "user", content }] });
const extractorCall = (ts: ConversationTurn[] = turns): ModelCompleteInput => ({
  system: EXTRACTOR_SYSTEM_PROMPT,
  messages: [{ role: "user", content: buildExtractorUserMessage(ts, { recentTitles: ["Something from conversation://old/9"] }) }],
  maxTokens: 4096,
});

const CONFIG: BrainConfig = {
  version: 1,
  repoId: "01KREPO0000000000000000000",
  links: { relationships: ["related", "supports"] },
  sync: { quiescenceMs: 1500 },
  grounding: { lowContentMaxTokens: 4, confirmationLexicon: ["yes"] },
};

function plannerCall(): ModelCompleteInput {
  const input: PlannerInput = {
    candidate: { kind: "idea", claim: "Undo replaces approval", groundedSources: [`conversation://${SESSION}/000001`, `conversation://${SESSION}/000003`], inferences: [] },
    turns,
    notes: [
      {
        noteId: "01KNOTE00000000000000000000",
        path: "knowledge/old.md",
        slug: "old",
        title: "Old",
        status: "active",
        type: "idea",
        blobHash: "0".repeat(40),
        // a retrieved note citing another session must not be mistaken for the call's own turns
        raw: "---\nid: 01KNOTE00000000000000000000\ncreated: 2026-01-01\ntype: idea\nstatus: active\n---\n# Old\n\n## Claim\nx\nGrounded-in: conversation://old/7\n- [user] conversation://old/8: quoted\n",
      },
    ],
    neighbors: [],
    pendingMutations: [],
    pendingProposals: [],
    rejectedProposals: [],
    config: CONFIG,
    today: "2026-10-02",
    nsKeys: new Set(["old"]),
  };
  return { system: PLANNER_SYSTEM_PROMPT, messages: [{ role: "user", content: buildPlannerUserMessage(input) }], maxTokens: 16000 };
}

function provider(script: ModelScript, callLog: string | null = join(dir, "calls.jsonl")): ModelScriptProvider {
  return new ModelScriptProvider(script, { baseDir: dir, callLog, pollMs: 5 });
}

function readLog(path = join(dir, "calls.jsonl")): ScriptCallLogLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as ScriptCallLogLine);
}

/** Tracks whether a promise settled, without unhandled-rejection noise. */
function track<T>(p: Promise<T>): { p: Promise<T>; settled: () => boolean } {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  return { p, settled: () => done };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("model script: parsing", () => {
  test("a valid script round-trips; entries keep their fields", () => {
    const s = parseModelScript({
      version: 1,
      callLog: "log.jsonl",
      chunkDelayMs: 0,
      chat: [{ response: "hi", hold: "go" }],
      extractor: [{ fail: { message: "503", retryable: true, status: 503 }, repeat: "online" }, { response: { candidates: [] } }],
      planner: [{ response: { operations: [] }, repeat: true }],
    });
    expect(s.chat).toEqual([{ response: "hi", hold: "go" }]);
    expect(s.extractor![0]).toEqual({ fail: { message: "503", retryable: true, status: 503 }, repeat: "online" });
    expect(s.planner).toEqual([{ response: { operations: [] }, repeat: true }]);
    expect(s.callLog).toBe("log.jsonl");
  });

  test("malformed scripts are rejected with the offending location", () => {
    const bad = (raw: unknown) => () => parseModelScript(raw, "s.json");
    expect(bad([])).toThrow("s.json: must be a JSON object");
    expect(bad({ extracter: [] })).toThrow('unknown key "extracter"');
    expect(bad({ version: 2 })).toThrow("unsupported version 2");
    expect(bad({ chat: {} })).toThrow('"chat" must be an array');
    expect(bad({ chat: [{}] })).toThrow('chat[0]: exactly one of "response" and "fail"');
    expect(bad({ chat: [{ response: "x", fail: { message: "m", retryable: true } }] })).toThrow("exactly one of");
    expect(bad({ chat: [{ response: null }] })).toThrow('"response" must not be null');
    expect(bad({ chat: [{ response: "x", hold: "" }] })).toThrow('chat[0]: "hold" must be a non-empty string');
    expect(bad({ chat: [{ response: "x", wait: "f" }] })).toThrow('chat[0]: unknown key "wait"');
    expect(bad({ planner: [{ fail: { message: "m" } }] })).toThrow("planner[0].fail.retryable must be a boolean");
    expect(bad({ planner: [{ fail: { message: "m", retryable: true, status: "503" } }] })).toThrow("fail.status must be an integer");
    expect(bad({ extractor: [{ response: "a", repeat: true }, { response: "b" }] })).toThrow("must be the last extractor entry");
    expect(bad({ extractor: [{ response: "a", repeat: false }] })).toThrow('"repeat" must be true or a release file path');
    expect(bad({ chunkDelayMs: -1 })).toThrow('"chunkDelayMs" must be a number');
  });

  test("loadModelScript names the file on unreadable or invalid JSON", () => {
    const p = join(dir, "broken.json");
    writeFileSync(p, "{ not json");
    expect(() => loadModelScript(p)).toThrow(`model script ${p}: invalid JSON`);
    expect(() => loadModelScript(join(dir, "missing.json"))).toThrow("cannot read");
  });
});

describe("ModelScriptProvider", () => {
  test("dispatches by system prompt; each role plays its own entries in order; JSON values are stringified", async () => {
    const m = provider({
      chat: [{ response: "first reply" }, { response: "second reply" }],
      extractor: [{ response: { candidates: [] } }],
      planner: [{ response: '{"operations": []}' }],
    });
    expect(await m.complete(chatCall())).toBe("first reply");
    expect(await m.complete(extractorCall())).toBe('{"candidates":[]}');
    expect(await m.complete(chatCall())).toBe("second reply");
    expect(await m.complete(plannerCall())).toBe('{"operations": []}');
    expect(m.calls.length).toBe(4); // recorded by MockModelProvider
    await expect(m.complete({ system: "something else", messages: [] })).rejects.toThrow("unknown system prompt");
    expect(readLog().map((l) => [l.role, l.entry])).toEqual([
      ["chat", 0],
      ["extractor", 0],
      ["chat", 1],
      ["planner", 0],
      ["unknown", null],
    ]);
  });

  test("placeholders resolve from the call's own turns; unknown or unresolvable ones are errors", async () => {
    expect(turnsInCall("extractor", extractorCall()).map((t) => `${t.role}:${t.turnId}`)).toEqual(["user:000001", "assistant:000002", "user:000003", "assistant:000004"]);
    // the planner sees only cited turns; URIs inside retrieved notes are ignored
    expect(turnsInCall("planner", plannerCall()).map((t) => `${t.sessionId}/${t.turnId}`)).toEqual([`${SESSION}/000001`, `${SESSION}/000003`]);

    const m = provider({
      extractor: [{ response: { candidates: [{ claim: "c", groundedSources: ["{{lastUser}}", "conversation://{{ session }}/000001"] }] } }],
      planner: [{ response: "Grounded-in: {{lastUser}} in {{session}}" }],
      chat: [{ response: "about {{session}}" }, { response: "{{sesion}}" }],
    });
    expect(JSON.parse(await m.complete(extractorCall()))).toEqual({
      candidates: [{ claim: "c", groundedSources: [`conversation://${SESSION}/000003`, `conversation://${SESSION}/000001`] }],
    });
    expect(await m.complete(plannerCall())).toBe(`Grounded-in: conversation://${SESSION}/000003 in ${SESSION}`);
    await expect(m.complete(chatCall())).rejects.toThrow("{{session}} cannot be resolved for a chat call");
    await expect(m.complete(chatCall())).rejects.toThrow("unknown placeholder {{sesion}}");
  });

  test("hold: a held call is logged at once, stays pending until the release file exists, then answers", async () => {
    const m = provider({ extractor: [{ response: { candidates: [] }, hold: "release-extractor" }] });
    const call = track(m.complete(extractorCall()));
    await tick(60);
    expect(call.settled()).toBe(false);
    const log = readLog();
    expect(log.length).toBe(1);
    expect(log[0]).toMatchObject({ role: "extractor", entry: 0, hold: join(dir, "release-extractor") });
    writeFileSync(join(dir, "release-extractor"), "");
    expect(await call.p).toBe('{"candidates":[]}');
  });

  test("hold on a streamed chat reply: a pending stream with no deltas, then chunks that concatenate to the reply", async () => {
    const reply = "Cheap undo moves the approval step to an after-the-fact review of commits.";
    const m = provider({ chunkDelayMs: 0, chat: [{ response: reply, hold: "sub/release-reply" }] });
    const deltas: string[] = [];
    const call = track(m.stream(chatCall(), (d) => deltas.push(d)));
    await tick(60);
    expect(call.settled()).toBe(false);
    expect(deltas).toEqual([]);
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "release-reply"), "");
    expect(await call.p).toBe(reply);
    expect(deltas).toEqual(chunkWords(reply));
    expect(deltas.length).toBeGreaterThan(1);
  });

  test("fail: throws ModelProviderError with the scripted retryable flag and status, after any hold", async () => {
    const m = provider({
      planner: [
        { fail: { message: "overloaded", retryable: true, status: 529 } },
        { fail: { message: "bad request", retryable: false } },
        { fail: { message: "late failure", retryable: true }, hold: "release-fail" },
      ],
      chat: [{ fail: { message: "reply failed", retryable: true } }],
    });
    const first = await m.complete(plannerCall()).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(ModelProviderError);
    expect(first).toMatchObject({ message: "overloaded", retryable: true, status: 529 });
    const second = await m.complete(plannerCall()).catch((e: unknown) => e);
    expect(second).toBeInstanceOf(ModelProviderError);
    expect(second).toMatchObject({ message: "bad request", retryable: false, status: undefined });

    const held = track(m.complete(plannerCall()).catch((e: unknown) => e));
    await tick(60);
    expect(held.settled()).toBe(false);
    writeFileSync(join(dir, "release-fail"), "");
    expect(await held.p).toMatchObject({ message: "late failure", retryable: true });

    const deltas: string[] = [];
    await expect(m.stream(chatCall(), (d) => deltas.push(d))).rejects.toBeInstanceOf(ModelProviderError);
    expect(deltas).toEqual([]);
    expect(readLog().map((l) => l.fail)).toEqual([true, true, true, true]);
  });

  test('repeat: "<file>" answers until the file exists, then the next entry; repeat: true answers forever', async () => {
    const m = provider({
      extractor: [
        { fail: { message: "offline", retryable: true }, repeat: "online" },
        { response: "A" },
        { response: "B", repeat: true },
      ],
    });
    for (let i = 0; i < 3; i++) await expect(m.complete(extractorCall())).rejects.toMatchObject({ message: "offline", retryable: true });
    writeFileSync(join(dir, "online"), "");
    expect(await m.complete(extractorCall())).toBe("A");
    for (let i = 0; i < 3; i++) expect(await m.complete(extractorCall())).toBe("B");
    expect(readLog().map((l) => l.entry)).toEqual([0, 0, 0, 1, 2, 2, 2]);
  });

  test("a role that runs out throws a plain (non-provider) Error naming the role; the call is still logged", async () => {
    const m = provider({ chat: [{ response: "only one" }] });
    expect(await m.complete(chatCall())).toBe("only one");
    const e = await m.complete(chatCall("again")).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(ModelProviderError);
    expect((e as Error).message).toBe("model script: no chat entry left (call #2, chat entries: 1)");
    await expect(m.complete(extractorCall())).rejects.toThrow("no extractor entry left");
    expect(readLog().map((l) => [l.seq, l.role, l.entry])).toEqual([
      [1, "chat", 0],
      [2, "chat", null],
      [3, "extractor", null],
    ]);
  });

  test("call log: one JSONL line per call with role, system, input messages and maxTokens", async () => {
    const m = provider({ chat: [{ response: "r" }], extractor: [{ response: { candidates: [] } }] });
    await m.complete(chatCall("what did I say about undo?"));
    const ex = extractorCall();
    await m.complete(ex);
    const log = readLog();
    expect(log.length).toBe(2);
    expect(log[0]).toMatchObject({ seq: 1, pid: process.pid, role: "chat", entry: 0, messages: [{ role: "user", content: "what did I say about undo?" }] });
    expect(log[0]!.system.startsWith(CHAT_SYSTEM_PROMPT)).toBe(true);
    expect(log[0]!.maxTokens).toBeUndefined();
    expect(Number.isNaN(Date.parse(log[0]!.at))).toBe(false);
    expect(log[1]).toMatchObject({ seq: 2, role: "extractor", system: EXTRACTOR_SYSTEM_PROMPT, messages: ex.messages, maxTokens: 4096 });
    expect(log[1]!.messages[0]!.content).toContain(`[conversation://${SESSION}/000002] assistant: So undo replaces approval.`);

    // logging can be switched off for in-process use
    const quiet = provider({ chat: [{ response: "r" }] }, null);
    await quiet.complete(chatCall());
    expect(quiet.callLogPath).toBeNull();
    expect(readLog().length).toBe(2);
  });

  test("createModelScriptProvider: relative paths resolve against the script; log path is env, else callLog, else <name>.calls.jsonl", async () => {
    const scripts = join(dir, "scripts");
    mkdirSync(scripts);
    const plain = join(scripts, "writer-a.json");
    writeFileSync(plain, JSON.stringify({ chat: [{ response: "a", hold: "go-a" }] }));
    writeFileSync(join(scripts, "go-a"), "");
    const a = createModelScriptProvider(plain, {});
    expect(a.callLogPath).toBe(join(scripts, "writer-a.calls.jsonl"));
    expect(defaultCallLogPath("/x/y/script")).toBe("/x/y/script.calls.jsonl");
    expect(await a.complete(chatCall())).toBe("a"); // released by scripts/go-a, not ./go-a
    expect(readLog(join(scripts, "writer-a.calls.jsonl")).length).toBe(1);

    const withLog = join(scripts, "writer-b.json");
    writeFileSync(withLog, JSON.stringify({ callLog: "logs/b.jsonl", chat: [{ response: "b" }] }));
    expect(createModelScriptProvider(withLog, {}).callLogPath).toBe(join(scripts, "logs", "b.jsonl"));
    const envLog = join(dir, "env-log.jsonl");
    const b = createModelScriptProvider(withLog, { BRAIN_MODEL_SCRIPT_LOG: envLog });
    expect(b.callLogPath).toBe(envLog);
    await b.complete(chatCall());
    expect(readLog(envLog).map((l) => l.role)).toEqual(["chat"]);
    expect(existsSync(join(scripts, "logs", "b.jsonl"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// brain chat --once under BRAIN_MODEL_SCRIPT
// ---------------------------------------------------------------------------

describe("brain chat under BRAIN_MODEL_SCRIPT (CLI)", () => {
  const CLI = resolve(import.meta.dir, "../../src/cli.ts");
  /** Child env: no model keys or provider settings leak in from the developer's environment or `.env`. */
  const STRIP = [
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "BRAIN_MODEL_PROVIDER",
    "BRAIN_MODEL",
    "BRAIN_EFFORT",
    "BRAIN_EMBEDDINGS",
    "BRAIN_EMBEDDING_MODEL",
    "BRAIN_EMBEDDING_DIMS",
    "BRAIN_MODEL_MOCK",
    "BRAIN_MODEL_SCRIPT",
    "BRAIN_MODEL_SCRIPT_LOG",
  ];
  let home: string;
  let repo: string;
  beforeEach(() => {
    home = join(dir, "home");
    repo = join(dir, "repo");
    mkdirSync(home);
    mkdirSync(repo);
  });

  function run(args: string[], extra: Record<string, string> = {}): { code: number; out: string; err: string } {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), BRAIN_HOME: home };
    for (const k of STRIP) delete env[k];
    const r = Bun.spawnSync(["bun", CLI, ...args], { cwd: repo, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  const REPLY = "So cheap undo turns approval into an after-the-fact review.";
  const USER_TEXT = "Reversible agent actions mean an agent can act with much less pre-approval from me.";
  const NEW_PATH = "knowledge/undo-replaces-approval.md";

  test(
    "chat --once: the scripted knowledge run lands a CREATE on main and a PENDING ARCHIVE proposal; the call log shows what each call saw",
    () => {
      expect(run(["init", repo]).code).toBe(0);
      const seed = writeNote(repo, "knowledge/reversible-agent-actions.md", {
        title: "Reversible agent actions",
        sections: { Claim: "Reversible agent actions can be undone cheaply.\nGrounded-in: conversation://old/1" },
      });
      commitAsHuman(repo, "user: seed note");

      const scriptPath = join(dir, "writer.json");
      const script: ModelScript = {
        chat: [{ response: REPLY }],
        extractor: [
          {
            response: {
              candidates: [{ kind: "idea", claim: "Reversible agent actions let an agent act with less pre-approval", groundedSources: ["{{lastUser}}"], inferences: [] }],
            },
          },
        ],
        planner: [
          {
            response: {
              operations: [
                {
                  op: "CREATE",
                  path: NEW_PATH,
                  content:
                    "---\nid: NEW\ncreated: 2026-10-02\ntype: idea\nstatus: active\n---\n# Undo replaces approval\n\n## Claim\nCheap undo lets an agent act first and be reviewed afterwards.\nGrounded-in: {{lastUser}}\n\n## Connections\n- supports [[reversible-agent-actions]]\n",
                  reasoning: "a distinct concept",
                },
                {
                  op: "ARCHIVE",
                  noteIds: [seed.id],
                  writes: [{ path: seed.path, content: seed.content.replace("status: active", "status: archived") }],
                  reasoning: "superseded by the new note",
                  evidence: ["{{lastUser}}"],
                },
              ],
            },
          },
        ],
      };
      writeFileSync(scriptPath, JSON.stringify(script, null, 2));

      // BRAIN_MODEL_MOCK is set too: the script wins
      const r = run(["chat", "--once", USER_TEXT, "--wait"], { BRAIN_MODEL_SCRIPT: scriptPath, BRAIN_MODEL_MOCK: "1" });
      expect(r.err).toContain(`BRAIN_MODEL_SCRIPT is set: answering model calls from ${scriptPath}`);
      expect(r.err).not.toContain("knowledge:"); // no knowledge errors
      expect(r.code).toBe(0);
      expect(r.out).toBe(`${REPLY}\nKnowledge updated · 1 note (1 created) · 1 proposal\n`);
      const sessionId = r.err.match(/session ([0-7][0-9A-HJKMNP-TV-Z]{25})/)![1]!;

      // the named mutation landed on main with its trailers
      const ids = mutationIdsOn(repo, "main");
      expect(ids.length).toBe(1);
      const sha = revList(repo, "main")[0]!;
      expect(trailer(repo, sha, "Mutation-Type")).toBe("CREATE");
      expect(trailer(repo, sha, "Mutation-ID")).toBe(ids[0]!);
      const created = fileAt(repo, "main", NEW_PATH)!;
      expect(created).toContain(`Grounded-in: conversation://${sessionId}/000001`);
      expect(created).not.toContain("id: NEW");

      // the proposal is pending in the store
      const listed = run(["proposals", "list", "--json"]);
      expect(listed.code).toBe(0);
      const proposals = JSON.parse(listed.out) as { operation: string; status: string; targets: { noteId: string; path: string }[]; evidence: string[] }[];
      expect(proposals.length).toBe(1);
      expect(proposals[0]).toMatchObject({ operation: "ARCHIVE", status: "PENDING", targets: [{ noteId: seed.id, path: seed.path }] });
      expect(proposals[0]!.evidence).toContain(`conversation://${sessionId}/000001`);
      const status = JSON.parse(run(["status", "--json"]).out);
      expect(status.pendingProposals).toBe(1);
      expect(status.queue.INTEGRATED).toBe(1);
      expect(fileAt(repo, "main", seed.path)).toBe(seed.content); // a proposal changes nothing until accepted

      // the call log (default: next to the script) records each call's role and input
      const log = readLog(join(dir, "writer.calls.jsonl"));
      expect(log.map((l) => l.role)).toEqual(["chat", "extractor", "planner"]);
      expect(log[0]!.messages).toEqual([{ role: "user", content: USER_TEXT }]);
      const extractorInput = log[1]!.messages[0]!.content;
      expect(extractorInput).toContain(`[conversation://${sessionId}/000001] user: ${USER_TEXT}`);
      expect(extractorInput).toContain(`[conversation://${sessionId}/000002] assistant: ${REPLY}`);
      expect(log[2]!.messages[0]!.content).toContain(`noteId: ${seed.id}`);
    },
    60_000,
  );

  test(
    "an invalid script is a one-line CLI error before any turn is stored",
    () => {
      expect(run(["init", repo]).code).toBe(0);
      const scriptPath = join(dir, "bad.json");
      writeFileSync(scriptPath, JSON.stringify({ extracter: [] }));
      const r = run(["chat", "--once", USER_TEXT], { BRAIN_MODEL_SCRIPT: scriptPath });
      expect(r.code).toBe(1);
      expect(r.err).toContain(`model script ${scriptPath}: unknown key "extracter"`);
      expect(r.err).not.toContain("    at ");
      expect(r.err).not.toMatch(/session [0-7]/);
    },
    30_000,
  );
});
