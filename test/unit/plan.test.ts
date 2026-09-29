/**
 * Phase 9 unit tests — planner context, prompts, parsing, materialization and
 * end-to-end planning against a real coordinator (spec §36, §39–40, §3.19;
 * I-4, I-17, I-20).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { AGENT_BRANCH } from "../../src/core/types";
import type { ConversationTurn, ExtractionCandidate, Proposal } from "../../src/core/types";
import { openIndex, type IndexDb } from "../../src/index/schema";
import { HashingEmbeddingProvider, ensureEmbeddings } from "../../src/retrieval/embeddings";
import { buildPlannerInput, type PlannerInput } from "../../src/plan/context";
import { PLAN_ISSUE } from "../../src/plan/mutationValidator";
import { materialize, parsePlannerOutput, planCandidate } from "../../src/plan/planner";
import { PLANNER_SYSTEM_PROMPT, buildPlannerUserMessage } from "../../src/plan/prompts";
import { ScriptedModelProvider } from "../../src/plan/testing";
import { setupEnv, seedNote, blobAt, fileAt, mutationIdsOn, newMutationId, noteMd, revParse, type Env } from "../harness";

const embeddings = new HashingEmbeddingProvider();
const TODAY = "2026-09-29";

const turns: ConversationTurn[] = [
  { sessionId: "sess", turnId: "1", role: "user", text: "Reversible state transitions let an agent act with much less pre-approval from me." },
  { sessionId: "sess", turnId: "2", role: "assistant", text: "So review-oriented UI matters more than operational UI?" },
  { sessionId: "sess", turnId: "3", role: "user", text: "exactly" },
  { sessionId: "sess", turnId: "4", role: "user", text: "And because undo is cheap, review after the fact is enough for low-risk work." },
];

const candidate: ExtractionCandidate = {
  kind: "idea",
  claim: "Reversible state transitions let an agent act with less pre-approval",
  groundedSources: ["conversation://sess/1"],
  inferences: [{ text: "review-oriented UI matters more than operational UI", basedOn: ["conversation://sess/2"] }],
};

let env: Env;
let db: IndexDb | null = null;
let ids: Record<string, string>;
let paths: Record<string, string>;

beforeEach(async () => {
  env = await setupEnv();
  ids = {};
  paths = {};
  const seed = (key: string, rel: string, spec: Parameters<typeof seedNote>[2]) => {
    ids[key] = seedNote(env, rel, spec).id;
    paths[key] = rel;
  };
  seed("rev", "knowledge/reversibility-enables-agent-autonomy.md", {
    title: "Reversibility enables agent autonomy",
    sections: {
      Claim: "Reversible state transitions let an autonomous system operate with less pre-approval.\nGrounded-in: conversation://old/7",
      Evolution: "### 2026-01-01 — tentative\nEarlier framing.\nSource: conversation://old/9",
    },
  });
  seed("safe", "knowledge/safe-agent-changes.md", {
    title: "Safe agent changes",
    aliases: ["Git as a trust layer"],
    sections: {
      Claim: "Agents can make aggressive changes safely when every write is a reviewable commit.\nGrounded-in: conversation://old/3",
      Connections: "- supports [[reversibility-enables-agent-autonomy]]",
    },
  });
  seed("zebra", "knowledge/zebra-stripes.md", {
    title: "Zebra stripes",
    sections: { Claim: "Zebra stripes confuse biting flies.\nGrounded-in: conversation://old/1" },
  });
  seed("coffee", "knowledge/coffee-brewing.md", {
    title: "Coffee brewing",
    status: "superseded",
    sections: { Claim: "Coarse grounds and a slow pour give a sweeter cup.\nGrounded-in: conversation://old/2" },
  });
  env.clock.advance(60_000);
  await env.coord.integrate();
  await env.coord.reconcileIndex();
  db = openIndex(env.coord.paths.indexDb);
  await ensureEmbeddings(db, embeddings);
});

afterEach(async () => {
  db?.close();
  db = null;
  await env.cleanup();
});

function deps() {
  return { coord: env.coord, db: db!, embeddings, today: TODAY };
}

async function input(opts: { limit?: number } = {}): Promise<PlannerInput> {
  return buildPlannerInput(deps(), candidate, turns, opts);
}

function noteOf(inp: PlannerInput, key: string) {
  const n = inp.notes.find((x) => x.noteId === ids[key]);
  if (!n) throw new Error(`note ${key} not retrieved`);
  return n;
}

const plan = (ops: unknown[]) => JSON.stringify({ operations: ops });

let pCounter = 0;
function mkProposal(p: Pick<Proposal, "operation" | "targets" | "writes"> & Partial<Proposal>): Proposal {
  pCounter += 1;
  return {
    proposalId: p.proposalId ?? `prop_TEST${String(pCounter).padStart(6, "0")}`,
    mutationId: p.mutationId ?? newMutationId(),
    operation: p.operation,
    targets: p.targets,
    writes: p.writes,
    evidence: p.evidence ?? ["conversation://old/1"],
    reasoning: p.reasoning ?? "looks like the same idea",
    createdAt: p.createdAt ?? "2026-09-20T10:00:00.000Z",
    status: p.status ?? "PENDING",
  };
}

describe("buildPlannerInput", () => {
  test("retrieves the relevant notes with agent-HEAD content and blob hashes, plus the namespace", async () => {
    const inp = await input();
    expect(inp.notes[0]!.noteId).toBe(ids.rev!);
    const rev = noteOf(inp, "rev");
    const wt = env.coord.paths.agentWorktree;
    expect(rev.path).toBe(paths.rev!);
    expect(rev.slug).toBe("reversibility-enables-agent-autonomy");
    expect(rev.status).toBe("active");
    expect(rev.type).toBe("idea");
    expect(rev.blobHash).toBe(blobAt(wt, AGENT_BRANCH, rev.path)!);
    expect(rev.raw).toBe(fileAt(wt, AGENT_BRANCH, rev.path)!);
    expect(noteOf(inp, "coffee").status).toBe("superseded");
    expect(inp.nsKeys.has("zebra-stripes")).toBe(true);
    expect(inp.nsKeys.has("git as a trust layer")).toBe(true);
    expect(inp.today).toBe(TODAY);
    expect(inp.config.links.relationships).toContain("supports");
    expect(inp.pendingMutations).toEqual([]);
    expect(inp.pendingProposals).toEqual([]);
    expect(inp.rejectedProposals).toEqual([]);
    expect(inp.turns).toBe(turns);
  });

  test("graph neighbors of the top hit are listed when not retrieved themselves", async () => {
    const c: ExtractionCandidate = { kind: "idea", claim: "agents make aggressive changes safely", groundedSources: ["conversation://sess/1"], inferences: [] };
    const inp = await buildPlannerInput(deps(), c, turns, { limit: 1 });
    expect(inp.notes.map((n) => n.noteId)).toEqual([ids.safe!]);
    expect(inp.neighbors).toEqual([{ noteId: ids.rev!, path: paths.rev!, title: "Reversibility enables agent autonomy" }]);
  });

  test("pending mutations, pending proposals and rejected proposals (3.19) are supplied", async () => {
    const repo = env.repo.path;
    const snap = (key: string) => ({ noteId: ids[key]!, path: paths[key]!, blobHash: blobAt(repo, "main", paths[key]!)! });
    const rejected = mkProposal({ operation: "MERGE", targets: [snap("rev"), snap("safe")], writes: [{ path: paths.safe!, content: null }] });
    await env.coord.submitProposal(rejected);
    await env.coord.rejectProposal(rejected.proposalId, "these are distinct ideas");
    const pending = mkProposal({ operation: "ARCHIVE", targets: [snap("zebra")], writes: [{ path: paths.zebra!, content: "x" }] });
    await env.coord.submitProposal(pending);
    await env.coord.enqueue({
      mutationId: newMutationId(),
      type: "ENRICH",
      summary: "enrich zebra",
      targets: [{ kind: "present", ...snap("zebra") }],
      writes: [{ path: paths.zebra!, content: "y" }],
      dependsOn: [],
      evidence: [],
    });

    const inp = await input();
    expect(inp.rejectedProposals.map((p) => p.proposalId)).toEqual([rejected.proposalId]);
    expect(inp.pendingProposals.map((p) => p.proposalId)).toEqual([pending.proposalId]);
    expect(inp.pendingMutations.map((m) => m.state)).toEqual(["QUEUED"]);

    const msg = buildPlannerUserMessage(inp);
    expect(msg).toContain("do not propose MERGE of Reversibility enables agent autonomy and Safe agent changes: user rejected on ");
    expect(msg).toContain("these are distinct ideas");
    expect(msg).toContain(`${pending.proposalId} ARCHIVE [PENDING]`);
    expect(msg).toContain("ENRICH [QUEUED]");
    expect(msg).toContain("Today: 2026-09-29");
    expect(msg).toContain("conversation://sess/1: Reversible state transitions");
    expect(msg).toContain("conversation://sess/2:");
    expect(msg).not.toContain("conversation://sess/4:");
    expect(msg).toContain(`noteId: ${ids.rev}`);
    expect(msg).toContain("```markdown");
    expect(msg).toContain("related, supports, contradicts, extends, example-of");
  });
});

describe("parsePlannerOutput", () => {
  test("tolerates fences and prose, drops malformed ops, never throws", () => {
    expect(parsePlannerOutput("")).toEqual({ operations: [], parseError: "no JSON object found in planner output" });
    expect(parsePlannerOutput("I refuse.")).toEqual({ operations: [], parseError: "no JSON object found in planner output" });
    expect(parsePlannerOutput("{ not json")).toMatchObject({ operations: [] });
    expect(parsePlannerOutput("{ not json").parseError).toBeDefined();
    expect(parsePlannerOutput("{ not: json }").parseError).toMatch(/invalid JSON/);
    expect(parsePlannerOutput('{"operations": "nope"}').parseError).toBeDefined();
    expect(parsePlannerOutput("[1,2]").parseError).toBeDefined();
    expect(parsePlannerOutput('{"operations": []}')).toEqual({ operations: [] });
    expect(parsePlannerOutput("{}")).toEqual({ operations: [] });
    const fenced = "Here is the plan:\n```json\n" + plan([
      { op: "create", path: "knowledge/x.md", content: "c", reasoning: "r" },
      { op: "ENRICH", noteId: "n1", content: "c2" },
      { op: "ENRICH", content: "missing note id" },
      { op: "MERGE", noteIds: ["a", "b"], writes: [{ path: "knowledge/b.md", content: null }], evidence: ["conversation://s/1"] },
      { op: "MERGE", noteIds: ["a"], writes: "bad" },
      { op: "TELEPORT", noteId: "n1", content: "c" },
      "garbage",
    ]) + "\n```\nDone.";
    const r = parsePlannerOutput(fenced);
    expect(r.parseError).toBeUndefined();
    expect(r.operations).toEqual([
      { op: "CREATE", path: "knowledge/x.md", content: "c", reasoning: "r" },
      { op: "ENRICH", noteId: "n1", content: "c2" },
      { op: "MERGE", noteIds: ["a", "b"], writes: [{ path: "knowledge/b.md", content: null }], evidence: ["conversation://s/1"] },
    ]);
  });
});

describe("materialize", () => {
  test("binds ops to retrieved notes deterministically and drops unbindable ones", async () => {
    const inp = await input();
    const rev = noteOf(inp, "rev");
    const r = materialize(inp, [
      { op: "ENRICH", noteId: rev.noteId, content: rev.raw + "\n## Evidence\nx\n", reasoning: "why" },
      { op: "ENRICH", noteId: "01NOPE000000000000000000000", content: "x" },
      { op: "CREATE", path: "knowledge/Zebra-Stripes.md", content: noteMd({ title: "Zebra Stripes" }) },
      { op: "CREATE", path: "knowledge/Git as a trust layer.md", content: noteMd({ title: "Trust" }) },
      { op: "CREATE", path: "knowledge/new-idea.md", content: noteMd({ title: "New idea" }) },
      { op: "CREATE", path: "knowledge/new-idea.md", content: noteMd({ title: "New idea again" }) },
      { op: "CREATE", path: "../escape.md", content: "x" },
      { op: "MERGE", noteIds: [rev.noteId, ids.safe!], writes: [{ path: paths.safe!, content: null }], reasoning: "same idea", evidence: ["conversation://sess/4"] },
      { op: "MERGE", noteIds: [rev.noteId, "01NOPE000000000000000000000"], writes: [] },
      { op: "RENAME_SLUG", noteIds: [rev.noteId], writes: [{ path: "knowledge/renamed.md", content: "x" }, { path: rev.path, content: null }] },
    ]);
    expect(r.mutations.map((m) => m.type)).toEqual(["ENRICH", "CREATE"]);
    const enrich = r.mutations[0]!;
    expect(enrich.mutationId).toMatch(/^mut_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(enrich.targets).toEqual([{ kind: "present", noteId: rev.noteId, path: rev.path, blobHash: rev.blobHash }]);
    expect(enrich.writes).toEqual([{ path: rev.path, content: rev.raw + "\n## Evidence\nx\n" }]);
    expect(enrich.evidence).toEqual(["conversation://sess/1"]);
    expect(enrich.summary).toBe("enrich Reversibility enables agent autonomy");
    expect(enrich.reasoning).toBe("why");
    const create = r.mutations[1]!;
    expect(create.targets).toEqual([{ kind: "absent", slug: "new-idea" }]);
    expect(create.summary).toBe("create New idea");
    expect(r.proposals.length).toBe(1);
    const p = r.proposals[0]!;
    expect(p.proposalId).toMatch(/^prop_/);
    expect(p.mutationId).toMatch(/^mut_/);
    expect(p.status).toBe("PENDING");
    expect(p.operation).toBe("MERGE");
    expect(p.targets).toEqual([
      { noteId: rev.noteId, path: rev.path, blobHash: rev.blobHash },
      { noteId: ids.safe!, path: paths.safe!, blobHash: noteOf(inp, "safe").blobHash },
    ]);
    expect(p.writes).toEqual([{ path: paths.safe!, content: null }]);
    expect(p.evidence).toEqual(["conversation://sess/1", "conversation://sess/4"]);
    expect(p.createdAt).toBe("2026-09-29T00:00:00.000Z");
    expect(r.dropped.map((d) => d.reason)).toEqual([
      expect.stringContaining("not retrieved"),
      expect.stringContaining('slug "Zebra-Stripes" collides'),
      expect.stringContaining('slug "Git as a trust layer" collides'),
      expect.stringContaining("created twice"),
      expect.stringContaining("not a repo-relative"),
      expect.stringContaining("not retrieved"),
      expect.stringContaining('writes "knowledge/renamed.md" which is not a targeted note'),
    ]);
  });
});

describe("planCandidate", () => {
  test("a scripted ENRICH becomes a Mutation that coord.submit() integrates end-to-end", async () => {
    const inp = await input();
    const rev = noteOf(inp, "rev");
    const content = rev.raw + "\n## Evidence\nUndo is cheap, so review after the fact is enough for low-risk work.\nSource: conversation://sess/4\n";
    const provider = new ScriptedModelProvider([plan([{ op: "ENRICH", noteId: rev.noteId, content, reasoning: "grounded evidence for the same idea" }])]);

    const r = await planCandidate(provider, inp, { maxTokens: 4096 });
    expect(r.parseError).toBeUndefined();
    expect(r.dropped).toEqual([]);
    expect(r.proposals).toEqual([]);
    expect(r.mutations.length).toBe(1);
    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0]!.system).toBe(PLANNER_SYSTEM_PROMPT);
    expect(provider.calls[0]!.maxTokens).toBe(4096);
    expect(provider.calls[0]!.messages).toEqual([{ role: "user", content: buildPlannerUserMessage(inp) }]);
    expect(provider.remaining).toBe(0);

    const m = r.mutations[0]!;
    const before = revParse(env.repo.path, "main");
    const res = await env.coord.submit(m);
    expect(res.state).toBe("INTEGRATED");
    expect(revParse(env.repo.path, "main")).not.toBe(before);
    expect(fileAt(env.repo.path, "main", rev.path)).toBe(content);
    expect(mutationIdsOn(env.repo.path, "main")).toEqual([m.mutationId]);
  });

  test("CREATE + LINK to the new slug in one plan; colliding CREATE is dropped", async () => {
    const inp = await input();
    const safe = noteOf(inp, "safe");
    const created = noteMd({
      title: "Cheap undo",
      created: TODAY,
      sections: { Claim: "Cheap undo makes after-the-fact review sufficient for low-risk work.\nGrounded-in: conversation://sess/4", Connections: "- supports [[safe-agent-changes]]" },
    });
    const linked = safe.raw + "\n## Evidence\nSee [[cheap-undo]].\nSource: conversation://sess/4\n";
    const provider = new ScriptedModelProvider([
      plan([
        { op: "CREATE", path: "knowledge/zebra-stripes.md", content: noteMd({ title: "Zebra stripes again" }) },
        { op: "CREATE", path: "knowledge/cheap-undo.md", content: created },
        { op: "LINK", noteId: safe.noteId, content: linked },
      ]),
    ]);
    const r = await planCandidate(provider, inp);
    expect(r.dropped.length).toBe(1);
    expect(r.dropped[0]!.reason).toContain("collides");
    expect(r.mutations.map((m) => m.type)).toEqual(["CREATE", "LINK"]);
    for (const m of r.mutations) expect((await env.coord.submit(m)).state).toBe("INTEGRATED");
    // The system assigns the CREATE's id (planner.assignNoteId); compare everything else.
    const stripId = (s: string) => s.replace(/^id: .*$/m, "id: <assigned>");
    expect(stripId(fileAt(env.repo.path, "main", "knowledge/cheap-undo.md")!)).toBe(stripId(created));
    expect(fileAt(env.repo.path, "main", safe.path)).toBe(linked);
  });

  test("invalid automatic ops are dropped with validator codes", async () => {
    const inp = await input();
    const rev = noteOf(inp, "rev");
    const coffee = noteOf(inp, "coffee");
    const zebra = noteOf(inp, "zebra");
    const provider = new ScriptedModelProvider([
      plan([
        { op: "ENRICH", noteId: rev.noteId, content: rev.raw.replace("Reversible state transitions let", "Irreversible transitions block") },
        { op: "ADDITIVE_EVOLVE", noteId: rev.noteId, content: rev.raw.replace("Source: conversation://old/9", "Source: conversation://old/9\n\n### 2026-09-29 — tentative\nNo source here.") },
        { op: "ENRICH", noteId: coffee.noteId, content: coffee.raw + "\n## Evidence\nmore\nSource: conversation://sess/4\n" },
        { op: "LINK", noteId: zebra.noteId, content: zebra.raw + "\n## Connections\n- related [[does-not-exist]]\n" },
      ]),
    ]);
    const r = await planCandidate(provider, inp);
    expect(r.mutations).toEqual([]);
    expect(r.dropped.length).toBe(4);
    const codesOf = (i: number) => r.dropped[i]!.issues!.map((x) => x.code);
    expect(codesOf(0)).toEqual([PLAN_ISSUE.CLAIM_REWRITE]);
    expect(codesOf(1)).toEqual([PLAN_ISSUE.UNGROUNDED_EVOLUTION]);
    expect(codesOf(2)).toEqual([PLAN_ISSUE.PROPOSAL_REQUIRED]);
    expect(codesOf(3)).toEqual([PLAN_ISSUE.DANGLING_LINK_ADDED]);
    expect(r.dropped[2]!.mutation!.type).toBe("ENRICH");
    // Nothing reached the repo.
    expect(await env.coord.listMutations()).toEqual([]);
  });

  test("a MERGE op becomes a Proposal that coord.submitProposal accepts", async () => {
    const inp = await input();
    const rev = noteOf(inp, "rev");
    const safe = noteOf(inp, "safe");
    const merged = rev.raw + "\n## Evidence\nAgents can make aggressive changes safely when every write is a reviewable commit.\nSource: conversation://sess/4\n";
    const provider = new ScriptedModelProvider([
      plan([{ op: "MERGE", noteIds: [rev.noteId, safe.noteId], writes: [{ path: rev.path, content: merged }, { path: safe.path, content: null }], reasoning: "same concept", evidence: ["conversation://sess/4"] }]),
    ]);
    const r = await planCandidate(provider, inp);
    expect(r.mutations).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(r.proposals.length).toBe(1);
    const p = r.proposals[0]!;
    await env.coord.submitProposal(p);
    const listed = (await env.coord.listProposals()).find((x) => x.proposalId === p.proposalId);
    expect(listed?.status).toBe("PENDING");
    expect(listed?.targets).toEqual(p.targets);
    // Nothing changed on main until a human accepts.
    expect(fileAt(env.repo.path, "main", safe.path)).toBe(safe.raw);
    const accepted = await env.coord.acceptProposal(p.proposalId);
    expect(accepted.state).toBe("INTEGRATED");
    expect(fileAt(env.repo.path, "main", safe.path)).toBeNull();
    expect(fileAt(env.repo.path, "main", rev.path)).toBe(merged);
  });

  test("malformed model output yields no mutations, a parseError, and no throw", async () => {
    const inp = await input();
    const provider = new ScriptedModelProvider(["Sorry, I cannot produce a plan right now."]);
    const r = await planCandidate(provider, inp);
    expect(r.mutations).toEqual([]);
    expect(r.proposals).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(r.parseError).toBe("no JSON object found in planner output");
    expect(r.raw).toBe("Sorry, I cannot produce a plan right now.");

    const noop = new ScriptedModelProvider(['{"operations":[]}']);
    const r2 = await planCandidate(noop, inp);
    expect(r2).toMatchObject({ mutations: [], proposals: [], dropped: [] });
    expect(r2.parseError).toBeUndefined();
  });
});
