/**
 * `knowledge.event` keying in process (src/rpc/methods/conversation.ts;
 * protocol §5; T1.5): the parts of `turnKnowledgeEvents` that the transcripts
 * cannot reach. The transcripts (test/rpc/transcripts/conversation-send*.jsonl,
 * knowledge-event-overlap.jsonl, shutdown-*.jsonl, turn-lock-*.jsonl) cover
 * `conversation.send` end to end.
 *
 * - Events logged before the user turn is known are sent once it is, in order.
 * - `summary` is set on `done` only.
 * - A run that ends without `done` (a programmer error inside the run, which
 *   `runTurn` turns into an update with the failure in `errors[]`) still ends
 *   with a `done` carrying that update. A run that logged its own `done` gets
 *   no second one.
 * - Secrets in event strings are redacted.
 */
import { describe, expect, test } from "bun:test";
import type { KnowledgeEvent, KnowledgeUpdate } from "../../src/pipeline/knowledge";
import { createRpcServer } from "../../src/rpc";
import { turnKnowledgeEvents } from "../../src/rpc/methods/conversation";

type Msg = Record<string, any>;

const SESSION = "01JA00000000000000000000S1";

function harness() {
  const out: Msg[] = [];
  const server = createRpcServer({ send: (l) => out.push(JSON.parse(l)), baseEnv: {}, loadUserConfig: () => null });
  return { server, out };
}

function update(over: Partial<KnowledgeUpdate> = {}): KnowledgeUpdate {
  return { candidates: { accepted: 0, rejected: 0 }, mutations: [], proposals: [], dropped: [], noop: true, errors: [], ...over };
}

/** Resolves after pending promise reactions have run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe("turnKnowledgeEvents", () => {
  test("events logged before the turn is bound are sent on bind, in order; later ones at once; summary only on done", async () => {
    const { server, out } = harness();
    const k = turnKnowledgeEvents(server, SESSION);
    k.log({ type: "extracted", accepted: 1, rejected: 0 });
    k.log({ type: "error", message: "planner: no JSON object found" });
    expect(out).toEqual([]);

    const u = update({ candidates: { accepted: 1, rejected: 0 }, errors: ["planner: no JSON object found"] });
    k.bind("000003", Promise.resolve(u));
    expect(out.map((m) => m.data.event.type)).toEqual(["extracted", "error"]);
    k.log({ type: "done", update: u });
    await settle();

    expect(out).toEqual([
      { type: "knowledge.event", data: { sessionId: SESSION, turnId: "000003", event: { type: "extracted", accepted: 1, rejected: 0 } } },
      { type: "knowledge.event", data: { sessionId: SESSION, turnId: "000003", event: { type: "error", message: "planner: no JSON object found" } } },
      { type: "knowledge.event", data: { sessionId: SESSION, turnId: "000003", event: { type: "done", update: u }, summary: "Knowledge unchanged · 1 error" } },
    ]);
    expect(out.slice(0, 2).every((m) => !("summary" in m.data))).toBe(true);
  });

  test("a run that ends without done gets one from its update; a run that logged done gets no second one", async () => {
    const { server, out } = harness();
    const failed = update({ errors: ["knowledge: x is not a function"] });
    const crashed = turnKnowledgeEvents(server, SESSION);
    crashed.log({ type: "extracted", accepted: 0, rejected: 0 });
    crashed.bind("000001", Promise.resolve(failed));
    await settle();
    expect(out.map((m) => [m.data.turnId, m.data.event.type, m.data.summary])).toEqual([
      ["000001", "extracted", undefined],
      ["000001", "done", "Knowledge unchanged · 1 error"],
    ]);
    expect(out[1]!.data.event.update).toEqual(failed);

    out.length = 0;
    const ok = update();
    const normal = turnKnowledgeEvents(server, SESSION);
    let resolve!: (u: KnowledgeUpdate) => void;
    normal.bind("000003", new Promise((r) => (resolve = r)));
    normal.log({ type: "done", update: ok });
    resolve(ok);
    await settle();
    expect(out.map((m) => [m.data.turnId, m.data.event.type])).toEqual([["000003", "done"]]);
  });

  test("secrets the server knows are redacted from event strings", async () => {
    const { server, out } = harness();
    server.redactor.add("sk-or-v1-not-a-real-key");
    const k = turnKnowledgeEvents(server, SESSION);
    k.bind("000001", new Promise(() => {}));
    const event: KnowledgeEvent = { type: "error", message: "extractor: openrouter: HTTP 401: bad key sk-or-v1-not-a-real-key" };
    k.log(event);
    expect(out[0]!.data.event.message).toBe("extractor: openrouter: HTTP 401: bad key [redacted]");
    expect(event.message).toContain("sk-or-v1-not-a-real-key"); // the run's own event is not changed
  });
});
