/**
 * Phase 11b unit tests — the conversation pipeline (spec §36, §39, §53;
 * design §3, §4, §17): reply first, knowledge later, never blocking.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ConversationTurn, ModelProvider } from "../../src/core/types";
import { openConversationStore, type ConversationStore } from "../../src/conversation/store";
import { MockModelProvider, type ModelCompleteInput } from "../../src/extract/extractor";
import { EXTRACTOR_SYSTEM_PROMPT } from "../../src/extract/prompts";
import { openIndex, type IndexDb } from "../../src/index/schema";
import { PLANNER_SYSTEM_PROMPT } from "../../src/plan/prompts";
import { CHAT_SYSTEM_PROMPT, buildChatMessages, excerptOf, retrieveContext } from "../../src/pipeline/chat";
import { formatKnowledgeSummary, processTurnForKnowledge, type KnowledgeEvent, type KnowledgeUpdate } from "../../src/pipeline/knowledge";
import { MOCK_CHAT_REPLY, StreamingMockModelProvider, chunkWords, createMockModelProvider } from "../../src/pipeline/mock";
import { runTurn } from "../../src/pipeline/session";
import { HashingEmbeddingProvider, ensureEmbeddings } from "../../src/retrieval/embeddings";
import { setupEnv, seedNote, fileAt, mutationIdsOn, revParse, type Env } from "../harness";

const embeddings = new HashingEmbeddingProvider();
const TODAY = "2026-09-29";
const REPLY = "That fits: cheap undo shifts the burden from approval to review.";
const USER_TEXT = "Reversible state transitions let an agent act with much less pre-approval from me.";

let env: Env;
let db: IndexDb | null = null;
let store: ConversationStore;
let rev: { id: string; path: string; content: string };
let safe: { id: string; path: string; content: string };

beforeEach(async () => {
  env = await setupEnv();
  rev = seedNote(env, "knowledge/reversibility-enables-agent-autonomy.md", {
    title: "Reversibility enables agent autonomy",
    sections: {
      Claim: "Reversible state transitions let an autonomous system operate with less pre-approval.\nGrounded-in: conversation://old/7",
      Evolution: "### 2026-01-01 — tentative\nEarlier framing.\nSource: conversation://old/9",
    },
  });
  safe = seedNote(env, "knowledge/safe-agent-changes.md", {
    title: "Safe agent changes",
    sections: {
      Claim: "Agents can make aggressive changes safely when every write is a reviewable commit.\nGrounded-in: conversation://old/3",
      Connections: "- supports [[reversibility-enables-agent-autonomy]]",
    },
  });
  seedNote(env, "knowledge/zebra-stripes.md", { title: "Zebra stripes", sections: { Claim: "Zebra stripes confuse biting flies.\nGrounded-in: conversation://old/1" } });
  env.clock.advance(60_000);
  await env.coord.integrate();
  await env.coord.reconcileIndex();
  db = openIndex(env.coord.paths.indexDb);
  await ensureEmbeddings(db, embeddings);
  store = openConversationStore(env.coord.paths.conversationsDir);
});

afterEach(async () => {
  db?.close();
  db = null;
  await env.cleanup();
});

/** A provider that routes on the system prompt: chat → reply, extractor/planner → scripted (string or function of the call). */
type Script = string | ((input: ModelCompleteInput) => string);
function routed(script: { chat?: string; extractor?: Script; planner?: Script }): MockModelProvider {
  const pick = (s: Script | undefined, input: ModelCompleteInput, what: string): string => {
    if (s === undefined) throw new Error(`unexpected ${what} call`);
    return typeof s === "function" ? s(input) : s;
  };
  return new MockModelProvider((input) => {
    if (input.system === EXTRACTOR_SYSTEM_PROMPT) return pick(script.extractor, input, "extractor");
    if (input.system === PLANNER_SYSTEM_PROMPT) return pick(script.planner, input, "planner");
    if (input.system.startsWith(CHAT_SYSTEM_PROMPT)) return script.chat ?? REPLY;
    throw new Error("unknown system prompt");
  });
}

const uri = (sessionId: string, turn: number) => `conversation://${sessionId}/${String(turn).padStart(6, "0")}`;
const extractorJson = (sessionId: string) =>
  JSON.stringify({
    candidates: [{ kind: "idea", claim: "Reversible state transitions let an agent act with less pre-approval", groundedSources: [uri(sessionId, 1)], inferences: [] }],
  });
const enrichedContent = (sessionId: string) => rev.content + `\n## Evidence\nUndo is cheap, so review after the fact is enough for low-risk work.\nSource: ${uri(sessionId, 1)}\n`;
const plan = (ops: unknown[]) => JSON.stringify({ operations: ops });

function deps(model: ModelProvider, log?: (e: KnowledgeEvent) => void) {
  return { coord: env.coord, db: db!, model, embeddings, config: env.coord.config, store, today: TODAY, ...(log ? { log } : {}) };
}

describe("runTurn + processTurnForKnowledge", () => {
  test("(1) grounded candidate → ENRICH integrated on main; reply appended to the store; events emitted", async () => {
    const sessionId = store.createSession();
    const model = routed({
      extractor: extractorJson(sessionId),
      planner: plan([{ op: "ENRICH", noteId: rev.id, content: enrichedContent(sessionId), reasoning: "grounded evidence" }]),
    });
    const events: KnowledgeEvent[] = [];
    const before = revParse(env.repo.path, "main");
    let delivered: KnowledgeUpdate | undefined;

    const r = await runTurn(deps(model, (e) => events.push(e)), sessionId, USER_TEXT, { onKnowledge: (u) => (delivered = u) });
    expect(r.reply).toBe(REPLY);
    expect(r.turn).toEqual({ sessionId, turnId: "000001", role: "user", text: USER_TEXT });
    expect(r.assistantTurn).toEqual({ sessionId, turnId: "000002", role: "assistant", text: REPLY });
    expect(r.contextNotes.map((n) => n.path)).toContain(rev.path);
    // the chat call saw the retrieved note after the stable prefix
    const chatCall = model.calls[0]!;
    expect(chatCall.system.startsWith(CHAT_SYSTEM_PROMPT)).toBe(true);
    expect(chatCall.system).toContain("Reversibility enables agent autonomy");
    expect(chatCall.messages).toEqual([{ role: "user", content: USER_TEXT }]);

    const u = await r.knowledge;
    expect(delivered).toBe(u);
    expect(u.errors).toEqual([]);
    expect(u.candidates).toEqual({ accepted: 1, rejected: 0 });
    expect(u.mutations.length).toBe(1);
    expect(u.mutations[0]).toMatchObject({ type: "ENRICH", state: "INTEGRATED", summary: "enrich Reversibility enables agent autonomy" });
    expect(u.proposals).toEqual([]);
    expect(u.noop).toBe(false);
    expect(formatKnowledgeSummary(u)).toBe("Knowledge updated · 1 note (1 enriched)");

    expect(revParse(env.repo.path, "main")).not.toBe(before);
    expect(fileAt(env.repo.path, "main", rev.path)).toBe(enrichedContent(sessionId));
    expect(mutationIdsOn(env.repo.path, "main")).toEqual([u.mutations[0]!.mutationId]);
    expect((await env.coord.getMutation(u.mutations[0]!.mutationId))?.state).toBe("INTEGRATED");

    const turns = store.getTurns(sessionId);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(turns[1]!.text).toBe(REPLY);
    // the extractor saw both turns of the session
    const extractorCall = model.calls.find((c) => c.system === EXTRACTOR_SYSTEM_PROMPT)!;
    expect(extractorCall.messages[0]!.content).toContain(`[${uri(sessionId, 1)}] user:`);
    expect(extractorCall.messages[0]!.content).toContain(`[${uri(sessionId, 2)}] assistant:`);
    expect(extractorCall.messages[0]!.content).toContain("- Zebra stripes");
    expect(model.calls.length).toBe(3);
    expect(events.map((e) => e.type)).toEqual(["extracted", "planned", "mutation", "done"]);
  });

  test("(2) extractor finds nothing → noop, no planner call, no commit", async () => {
    const sessionId = store.createSession();
    const model = routed({ extractor: '{"candidates": []}' });
    const before = revParse(env.repo.path, "main");
    const r = await runTurn(deps(model), sessionId, "hello there", { awaitKnowledge: true });
    expect(r.reply).toBe(REPLY);
    const u = await r.knowledge;
    expect(u).toEqual({ candidates: { accepted: 0, rejected: 0 }, mutations: [], proposals: [], dropped: [], noop: true, errors: [] });
    expect(formatKnowledgeSummary(u)).toBe("Knowledge unchanged");
    expect(model.calls.length).toBe(2);
    expect(revParse(env.repo.path, "main")).toBe(before);
    expect(await env.coord.listMutations()).toEqual([]);
    expect(store.getTurns(sessionId).length).toBe(2);
  });

  test("(3) malformed planner output → errors populated, no throw, no commit", async () => {
    const sessionId = store.createSession();
    const model = routed({ extractor: extractorJson(sessionId), planner: "Sorry, I cannot produce a plan right now." });
    const before = revParse(env.repo.path, "main");
    const r = await runTurn(deps(model), sessionId, USER_TEXT);
    const u = await r.knowledge;
    expect(u.candidates.accepted).toBe(1);
    expect(u.errors).toEqual(["planner: no JSON object found in planner output"]);
    expect(u.mutations).toEqual([]);
    expect(u.noop).toBe(true);
    expect(formatKnowledgeSummary(u)).toBe("Knowledge unchanged · 1 error");
    expect(revParse(env.repo.path, "main")).toBe(before);
    expect(await env.coord.listMutations()).toEqual([]);
  });

  test("(3b) a provider failure in the extractor is reported, never thrown", async () => {
    const sessionId = store.createSession();
    const model = routed({
      extractor: () => {
        throw new Error("503 overloaded");
      },
    });
    const u = await (await runTurn(deps(model), sessionId, USER_TEXT)).knowledge;
    expect(u.errors).toEqual(["extractor: 503 overloaded"]);
    expect(u.noop).toBe(true);
    // ungrounded candidate (assistant turn as source) is rejected by the validator, not the model
    const sessionId2 = store.createSession();
    const bad = JSON.stringify({ candidates: [{ kind: "idea", claim: "x", groundedSources: [uri(sessionId2, 2)], inferences: [] }] });
    const u2 = await (await runTurn(deps(routed({ extractor: bad })), sessionId2, USER_TEXT)).knowledge;
    expect(u2.candidates).toEqual({ accepted: 0, rejected: 1 });
    expect(u2.dropped.length).toBe(1);
    expect(u2.dropped[0]!.reason).toContain("candidate rejected");
    expect(u2.noop).toBe(true);
  });

  test("(4) planner MERGE → proposal PENDING in the inbox; main untouched", async () => {
    const sessionId = store.createSession();
    const merged = rev.content + `\n## Evidence\nAgents can make aggressive changes safely when every write is a reviewable commit.\nSource: ${uri(sessionId, 1)}\n`;
    const model = routed({
      extractor: extractorJson(sessionId),
      planner: plan([{ op: "MERGE", noteIds: [rev.id, safe.id], writes: [{ path: rev.path, content: merged }, { path: safe.path, content: null }], reasoning: "same concept" }]),
    });
    const before = revParse(env.repo.path, "main");
    const u = await (await runTurn(deps(model), sessionId, USER_TEXT)).knowledge;
    expect(u.errors).toEqual([]);
    expect(u.mutations).toEqual([]);
    expect(u.proposals.length).toBe(1);
    expect(u.proposals[0]).toMatchObject({ operation: "MERGE", targets: [rev.path, safe.path] });
    expect(u.noop).toBe(false);
    expect(formatKnowledgeSummary(u)).toBe("Knowledge updated · 1 proposal");
    const listed = (await env.coord.listProposals()).find((p) => p.proposalId === u.proposals[0]!.proposalId);
    expect(listed?.status).toBe("PENDING");
    expect(revParse(env.repo.path, "main")).toBe(before);
    expect(fileAt(env.repo.path, "main", safe.path)).toBe(safe.content);
  });

  test("(5) the reply returns before knowledge resolves; the knowledge promise never rejects", async () => {
    const sessionId = store.createSession();
    let release: (s: string) => void = () => undefined;
    const gate = new Promise<string>((res) => (release = res));
    let extractorReached: () => void = () => undefined;
    const reached = new Promise<void>((res) => (extractorReached = res));
    const model: ModelProvider = {
      async complete(input) {
        if (input.system === EXTRACTOR_SYSTEM_PROMPT) {
          extractorReached();
          return gate;
        }
        if (input.system.startsWith(CHAT_SYSTEM_PROMPT)) return REPLY;
        throw new Error("unexpected call");
      },
    };
    let settled = false;
    const r = await runTurn(deps(model), sessionId, USER_TEXT);
    void r.knowledge.then(() => (settled = true));
    expect(r.reply).toBe(REPLY);
    expect(store.getTurns(sessionId).length).toBe(2);
    await reached; // the extractor was called, but it is still waiting on the gate
    expect(settled).toBe(false);
    release('{"candidates": []}');
    const u = await r.knowledge;
    expect(settled).toBe(true);
    expect(u.noop).toBe(true);

    // a second turn on the same session runs its knowledge after the first (chained), still never rejecting
    const r2 = await runTurn(deps(routed({ extractor: "not json at all" })), sessionId, "and another thought");
    const u2 = await r2.knowledge;
    expect(u2.noop).toBe(true);
    expect(u2.errors).toEqual(["extractor: no JSON object found in extractor output"]);
  });

  test("runTurn rejects an unknown session before touching the model", async () => {
    const model = routed({});
    await expect(runTurn(deps(model), "01ARZ3NDEKTSV4RRFFQ69G5FAV", "hi")).rejects.toThrow(/unknown session/);
    expect(model.calls.length).toBe(0);
  });

  test("processTurnForKnowledge honours the extractor window", async () => {
    const turns: ConversationTurn[] = [];
    for (let i = 1; i <= 12; i++) turns.push({ sessionId: "s", turnId: String(i), role: i % 2 ? "user" : "assistant", text: `turn ${i} with some words in it` });
    const model = routed({ extractor: '{"candidates": []}' });
    await processTurnForKnowledge({ coord: env.coord, db: db!, model, embeddings, config: env.coord.config, today: TODAY }, turns, { window: 3, recentTitles: [] });
    const msg = model.calls[0]!.messages[0]!.content;
    expect(msg).toContain("conversation://s/10]");
    expect(msg).toContain("conversation://s/12]");
    expect(msg).not.toContain("conversation://s/9]");
    expect(msg).not.toContain("Recent knowledge titles");
  });
});

describe("chat prompt", () => {
  test("stable prefix first, context after; turns map to roles", () => {
    const turns: ConversationTurn[] = [
      { sessionId: "s", turnId: "1", role: "user", text: "first" },
      { sessionId: "s", turnId: "2", role: "assistant", text: "reply" },
      { sessionId: "s", turnId: "3", role: "user", text: "second" },
    ];
    const { system, messages } = buildChatMessages(turns, [{ title: "T", path: "knowledge/t.md", excerpt: "an excerpt" }]);
    expect(system.startsWith(CHAT_SYSTEM_PROMPT)).toBe(true);
    expect(system.slice(CHAT_SYSTEM_PROMPT.length)).toContain("### T\n(knowledge/t.md)\nan excerpt");
    expect(messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ]);
    expect(buildChatMessages(turns, []).system).toBe(CHAT_SYSTEM_PROMPT);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/thinking partner/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/cite them by title/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Never tell the user to "save"/);
  });

  test("excerpts drop the title, collapse whitespace and cut on a word boundary", () => {
    expect(excerptOf("# Title\n\n## Claim\nA claim.\n\nMore.")).toBe("¶ ## Claim A claim. ¶ More.");
    const long = "# T\n" + "word ".repeat(300);
    const e = excerptOf(long);
    expect(e.length).toBeLessThanOrEqual(602);
    expect(e.endsWith(" …")).toBe(true);
  });

  test("retrieveContext reads title, path and excerpt from the index", async () => {
    const notes = await retrieveContext(db!, embeddings, "reversible transitions pre-approval", 2);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]!.title).toBe("Reversibility enables agent autonomy");
    expect(notes[0]!.path).toBe(rev.path);
    expect(notes[0]!.excerpt).toContain("Reversible state transitions");
    expect(notes[0]!.excerpt).not.toContain("---");
    expect(await retrieveContext(db!, embeddings, "   ", 2)).toEqual([]);
  });

  test("mock provider answers every role without credentials", async () => {
    const m = createMockModelProvider();
    expect(await m.complete({ system: EXTRACTOR_SYSTEM_PROMPT, messages: [] })).toBe('{"candidates": []}');
    expect(await m.complete({ system: PLANNER_SYSTEM_PROMPT, messages: [] })).toBe('{"operations": []}');
    expect(await m.complete({ system: CHAT_SYSTEM_PROMPT + "\n\nextra", messages: [] })).toBe(MOCK_CHAT_REPLY);
  });

  test("mock provider streams the canned reply in ~5-word chunks that concatenate to the reply", async () => {
    const m = createMockModelProvider();
    const deltas: string[] = [];
    const out = await m.stream({ system: CHAT_SYSTEM_PROMPT, messages: [] }, (d) => deltas.push(d));
    expect(out).toBe(MOCK_CHAT_REPLY);
    expect(deltas.join("")).toBe(MOCK_CHAT_REPLY);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas).toEqual(chunkWords(MOCK_CHAT_REPLY));
    for (const d of deltas.slice(0, -1)) expect(d.trim().split(/\s+/).length).toBe(5);
    expect(m.calls.length).toBe(1);
    expect(chunkWords("one two three four five six seven")).toEqual(["one two three four five ", "six seven"]);
  });
});

describe("runTurn streaming", () => {
  test("a provider with stream(): deltas arrive in order and concatenate to the stored assistant turn", async () => {
    const sessionId = store.createSession();
    const model = new StreamingMockModelProvider((input) => {
      if (input.system === EXTRACTOR_SYSTEM_PROMPT) return '{"candidates": []}';
      if (input.system.startsWith(CHAT_SYSTEM_PROMPT)) return REPLY;
      throw new Error("unexpected call");
    }, 0);
    const deltas: string[] = [];
    let repliedBeforeStore = false;
    const r = await runTurn(deps(model), sessionId, USER_TEXT, {
      onDelta: (d) => {
        deltas.push(d);
        if (store.getTurns(sessionId).length === 1) repliedBeforeStore = true;
      },
      awaitKnowledge: true,
    });
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe(REPLY);
    expect(r.reply).toBe(REPLY);
    expect(r.assistantTurn.text).toBe(REPLY);
    expect(store.getTurns(sessionId)[1]!.text).toBe(deltas.join(""));
    expect(repliedBeforeStore).toBe(true); // deltas were delivered before the assistant turn was appended
    // exactly one chat call, then the extractor (knowledge maintenance keeps using complete())
    expect(model.calls.map((c) => (c.system.startsWith(CHAT_SYSTEM_PROMPT) ? "chat" : c.system === EXTRACTOR_SYSTEM_PROMPT ? "extractor" : "?"))).toEqual(["chat", "extractor"]);
  });

  test("streamed and non-streamed replies store identical text (surrounding whitespace trimmed)", async () => {
    const script = (input: ModelCompleteInput) => (input.system === EXTRACTOR_SYSTEM_PROMPT ? '{"candidates": []}' : `\n  ${REPLY}  \n`);
    const a = store.createSession();
    const b = store.createSession();
    const deltas: string[] = [];
    const streamed = await runTurn(deps(new StreamingMockModelProvider(script, 0)), a, USER_TEXT, { onDelta: (d) => deltas.push(d), awaitKnowledge: true });
    const plain = await runTurn(deps(new MockModelProvider(script)), b, USER_TEXT, { awaitKnowledge: true });
    expect(deltas.join("").trim()).toBe(REPLY);
    expect(streamed.reply).toBe(REPLY);
    expect(plain.reply).toBe(REPLY);
    expect(store.getTurns(a)[1]!.text).toBe(store.getTurns(b)[1]!.text);
  });

  test("a provider without stream() falls back to complete(); a streaming provider without onDelta uses complete()", async () => {
    const sessionId = store.createSession();
    const plain = routed({ extractor: '{"candidates": []}' });
    const deltas: string[] = [];
    const r = await runTurn(deps(plain), sessionId, "hello", { onDelta: (d) => deltas.push(d), awaitKnowledge: true });
    expect(deltas).toEqual([]);
    expect(r.reply).toBe(REPLY);
    expect(store.getTurns(sessionId)[1]!.text).toBe(REPLY);

    let streamCalls = 0;
    class Spy extends StreamingMockModelProvider {
      override stream(input: ModelCompleteInput, onDelta: (t: string) => void): Promise<string> {
        streamCalls += 1;
        return super.stream(input, onDelta);
      }
    }
    const spy = new Spy((input) => (input.system === EXTRACTOR_SYSTEM_PROMPT ? '{"candidates": []}' : REPLY), 0);
    const s2 = store.createSession();
    const r2 = await runTurn(deps(spy), s2, "hello", { awaitKnowledge: true });
    expect(streamCalls).toBe(0);
    expect(r2.reply).toBe(REPLY);
    expect(spy.calls.length).toBe(2);
  });
});

describe("formatKnowledgeSummary", () => {
  const base = (): KnowledgeUpdate => ({ candidates: { accepted: 0, rejected: 0 }, mutations: [], proposals: [], dropped: [], noop: true, errors: [] });
  test("renders counts by verb, proposals, non-applied states and errors", () => {
    const u = base();
    u.mutations = [
      { mutationId: "m1", type: "CREATE", state: "INTEGRATED", summary: "a" },
      { mutationId: "m2", type: "ENRICH", state: "INTEGRATED", summary: "b" },
      { mutationId: "m3", type: "LINK", state: "REPLAN", summary: "c" },
    ];
    u.proposals = [{ proposalId: "p", operation: "MERGE", targets: [] }];
    u.noop = false;
    expect(formatKnowledgeSummary(u)).toBe("Knowledge updated · 2 notes (1 created, 1 enriched) · 1 proposal · 1 not applied (REPLAN)");
    const e = base();
    e.errors = ["x", "y"];
    expect(formatKnowledgeSummary(e)).toBe("Knowledge unchanged · 2 errors");
  });
});

describe("brain chat (CLI)", () => {
  const CLI = resolve(import.meta.dir, "../../src/cli.ts");
  let home: string;
  let repo: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "brain-chat-home-"));
    repo = mkdtempSync(join(tmpdir(), "brain-chat-repo-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });
  function run(args: string[], extraEnv: Record<string, string> = {}): { code: number; out: string; err: string } {
    const envVars: Record<string, string> = { ...(process.env as Record<string, string>), BRAIN_HOME: home, ...extraEnv };
    delete envVars["ANTHROPIC_API_KEY"]; // the mock must not need credentials
    const r = Bun.spawnSync(["bun", CLI, ...args], { cwd: repo, env: envVars, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  test(
    "chat --once with BRAIN_MODEL_MOCK=1 prints the canned reply and 'Knowledge unchanged', exits 0",
    () => {
      expect(run(["init", repo]).code).toBe(0);
      const r = run(["chat", "--once", "hello", "--wait"], { BRAIN_MODEL_MOCK: "1" });
      expect(r.code).toBe(0);
      // the reply is streamed to stdout delta by delta, yet the bytes are exactly what a single print produced
      expect(r.out).toBe(`${MOCK_CHAT_REPLY}\nKnowledge unchanged\n`);
      expect(r.err).toMatch(/session [0-7][0-9A-HJKMNP-TV-Z]{25}/);
      const sessionId = r.err.match(/session ([0-7][0-9A-HJKMNP-TV-Z]{25})/)![1]!;

      // without --wait the reply is still printed and the knowledge update still awaited, but not printed
      const quiet = run(["chat", "--once", "again", "--session", sessionId], { BRAIN_MODEL_MOCK: "1" });
      expect(quiet.code).toBe(0);
      expect(quiet.out).toBe(`${MOCK_CHAT_REPLY}\n`);
      expect(quiet.err).toContain("resumed, 2 turns");

      const j = run(["chat", "--once", "third", "--session", sessionId, "--json"], { BRAIN_MODEL_MOCK: "1" });
      expect(j.code).toBe(0);
      // --json never streams: stdout is exactly one JSON object
      expect(j.out.trimStart().startsWith("{")).toBe(true);
      expect(j.out.trimEnd().endsWith("}")).toBe(true);
      const parsed = JSON.parse(j.out);
      expect(parsed.sessionId).toBe(sessionId);
      expect(parsed.reply).toBe(MOCK_CHAT_REPLY);
      expect(parsed.knowledge.noop).toBe(true);
      expect(parsed.summary).toBe("Knowledge unchanged");

      expect(run(["chat", "--once"], { BRAIN_MODEL_MOCK: "1" }).code).toBe(2);
      const unknown = run(["chat", "--once", "x", "--session", "01ARZ3NDEKTSV4RRFFQ69G5FAV"], { BRAIN_MODEL_MOCK: "1" });
      expect(unknown.code).toBe(1);
      expect(unknown.err).toContain("unknown session");
    },
    60_000,
  );
});
