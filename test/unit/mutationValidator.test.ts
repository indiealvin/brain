/**
 * Phase 9 unit tests — deterministic mutation validator (spec §30–31, §36;
 * I-14, I-15, I-16, I-17, I-21, I-22). Pure: hand-built PlannerInput, no repo.
 */
import { describe, test, expect } from "bun:test";
import type { BrainConfig, ConversationTurn, Mutation, TargetPrecondition } from "../../src/core/types";
import { slugKey } from "../../src/core/slug";
import { parseNote } from "../../src/markdown/parse";
import type { PlannerInput, PlannerNote } from "../../src/plan/context";
import { PLAN_ISSUE, evolutionEntries, sourceUrisIn, validatePlannedMutation } from "../../src/plan/mutationValidator";
import { noteMd, present, absent, type NoteSpec } from "../harness";

const config: BrainConfig = {
  version: 1,
  repoId: "01TESTREPO0000000000000000",
  links: { relationships: ["related", "supports", "contradicts", "extends", "example-of"] },
  sync: { quiescenceMs: 1500 },
  grounding: { lowContentMaxTokens: 4, confirmationLexicon: ["yes", "yeah", "exactly", "right"] },
};

const turns: ConversationTurn[] = [
  { sessionId: "s", turnId: "1", role: "user", text: "Reversible state transitions let an agent act with much less pre-approval." },
  { sessionId: "s", turnId: "2", role: "assistant", text: "That suggests review-oriented UI matters more than operational UI." },
  { sessionId: "s", turnId: "3", role: "user", text: "exactly" },
  { sessionId: "s", turnId: "4", role: "user", text: "Also undo being cheap means after-the-fact review is enough for low-risk work." },
];

function plannerNote(path: string, spec: NoteSpec, blobHash = "blob-" + path): PlannerNote {
  const raw = noteMd(spec);
  const n = parseNote(path, raw);
  return {
    noteId: n.frontmatter.id,
    path,
    slug: n.slug,
    title: n.title,
    status: n.frontmatter.status,
    type: n.frontmatter.type,
    blobHash,
    raw,
  };
}

function mkInput(notes: PlannerNote[], extraKeys: string[] = []): PlannerInput {
  const nsKeys = new Set<string>();
  for (const n of notes) {
    nsKeys.add(slugKey(n.slug));
    for (const a of parseNote(n.path, n.raw).frontmatter.aliases) nsKeys.add(slugKey(a));
  }
  for (const k of extraKeys) nsKeys.add(slugKey(k));
  return {
    candidate: { kind: "idea", claim: "Reversible state transitions", groundedSources: ["conversation://s/1"], inferences: [] },
    turns,
    notes,
    neighbors: [],
    pendingMutations: [],
    pendingProposals: [],
    rejectedProposals: [],
    config,
    today: "2026-09-29",
    nsKeys,
  };
}

let seq = 0;
function mut(type: Mutation["type"], targets: TargetPrecondition[], writes: Mutation["writes"]): Mutation {
  seq += 1;
  return { mutationId: `mut_TEST${String(seq).padStart(22, "0")}`, type, summary: type.toLowerCase(), targets, writes, dependsOn: [], evidence: ["conversation://s/1"] };
}

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

/** ENRICH-style mutation replacing `note` with `content`. */
function replace(type: Mutation["type"], note: PlannerNote, content: string): Mutation {
  return mut(type, [present(note.noteId, note.path, note.blobHash)], [{ path: note.path, content }]);
}

const REV: NoteSpec = {
  id: "01NOTEREV000000000000000000",
  title: "Reversibility enables agent autonomy",
  sections: {
    Claim: "Reversible state transitions let an autonomous system operate with less pre-approval.\nGrounded-in: conversation://old-session/7",
    Evolution: "### 2026-01-01 — tentative\nEarlier framing.\nSource: conversation://old-session/9",
    Connections: "- supports [[safe-agent-changes]]\n- related [[never-existed]]",
  },
};
const SAFE: NoteSpec = { id: "01NOTESAFE00000000000000000", title: "Safe agent changes", aliases: ["Git as a trust layer"], sections: { Claim: "Every write is a reviewable commit.\nGrounded-in: conversation://old-session/3" } };

describe("helpers", () => {
  test("sourceUrisIn and evolutionEntries", () => {
    expect(sourceUrisIn("text\nGrounded-in: conversation://a/1, conversation://a/2\nSource: document://d#f.\nnope: x")).toEqual([
      "conversation://a/1",
      "conversation://a/2",
      "document://d#f",
    ]);
    expect(evolutionEntries("intro\n### 2026-01-01 — tentative\nbody a\nSource: conversation://a/1\n### 2026-02-02 — tentative\nbody b")).toEqual([
      { heading: "2026-01-01 — tentative", body: "body a\nSource: conversation://a/1" },
      { heading: "2026-02-02 — tentative", body: "body b" },
    ]);
  });
});

describe("validatePlannedMutation", () => {
  test("a grounded ENRICH that appends Evidence and keeps the Claim passes", () => {
    const rev = plannerNote("knowledge/reversibility-enables-agent-autonomy.md", REV);
    const input = mkInput([rev]);
    const content = rev.raw + "\n## Evidence\nUndo is cheap, so review after the fact is enough.\nSource: conversation://s/4\n";
    expect(validatePlannedMutation(replace("ENRICH", rev, content), { input, turns })).toEqual([]);
  });

  test("existing source URIs from unknown sessions are not re-validated (diff semantics)", () => {
    const rev = plannerNote("knowledge/reversibility-enables-agent-autonomy.md", REV);
    const input = mkInput([rev]);
    // Only an alias is added; the old Grounded-in from old-session stays untouched.
    const content = rev.raw.replace("status: active\n", "status: active\naliases:\n  - Reversibility and autonomy\n");
    expect(validatePlannedMutation(replace("ADD_ALIAS", rev, content), { input, turns })).toEqual([]);
  });

  test("(a) proposal types and deletions are PERMISSION", () => {
    const rev = plannerNote("knowledge/reversibility-enables-agent-autonomy.md", REV);
    const input = mkInput([rev]);
    expect(codes(validatePlannedMutation(replace("MERGE", rev, rev.raw), { input, turns }))).toEqual([PLAN_ISSUE.PERMISSION]);
    expect(codes(validatePlannedMutation(replace("RECONCILE_EVOLUTION", rev, rev.raw), { input, turns }))).toEqual([PLAN_ISSUE.PERMISSION]);
    const del = mut("ENRICH", [present(rev.noteId, rev.path, rev.blobHash)], [{ path: rev.path, content: null }]);
    expect(codes(validatePlannedMutation(del, { input, turns }))).toEqual([PLAN_ISSUE.PERMISSION]);
  });

  test("(b) write paths must map onto declared targets", () => {
    const rev = plannerNote("knowledge/reversibility-enables-agent-autonomy.md", REV);
    const safe = plannerNote("knowledge/safe-agent-changes.md", SAFE);
    const input = mkInput([rev, safe]);
    const stray = mut("ENRICH", [present(rev.noteId, rev.path, rev.blobHash)], [{ path: safe.path, content: safe.raw }]);
    expect(codes(validatePlannedMutation(stray, { input, turns }))).toEqual([PLAN_ISSUE.TARGET_MISMATCH]);
    const noWrite = mut("CREATE", [absent("brand-new")], []);
    expect(codes(validatePlannedMutation(noWrite, { input, turns }))).toEqual([PLAN_ISSUE.TARGET_MISMATCH]);
    // present target whose noteId is not among the retrieved notes
    const unknown = mut("ENRICH", [present("01UNKNOWN00000000000000000", rev.path, rev.blobHash)], [{ path: rev.path, content: rev.raw }]);
    expect(codes(validatePlannedMutation(unknown, { input, turns }))).toContain(PLAN_ISSUE.TARGET_MISMATCH);
  });

  test("(c) unparsable content, field errors and id changes", () => {
    const rev = plannerNote("knowledge/reversibility-enables-agent-autonomy.md", REV);
    const input = mkInput([rev]);
    expect(codes(validatePlannedMutation(replace("ENRICH", rev, "# no frontmatter\n"), { input, turns }))).toEqual([PLAN_ISSUE.PARSE_ERROR]);
    const badType = rev.raw.replace("type: idea", "type: rumor");
    const issues = validatePlannedMutation(replace("ENRICH", rev, badType), { input, turns });
    expect(codes(issues)).toContain("INVALID_TYPE");
    expect(codes(issues)).toContain(PLAN_ISSUE.TYPE_CHANGE_FORBIDDEN);
    const newId = rev.raw.replace(REV.id!, "01NOTEOTHER0000000000000000");
    expect(codes(validatePlannedMutation(replace("ENRICH", rev, newId), { input, turns }))).toEqual([PLAN_ISSUE.ID_CHANGE]);
  });

  test("(d) only active → tentative is automatic; type never changes", () => {
    const rev = plannerNote("knowledge/reversibility-enables-agent-autonomy.md", REV);
    const input = mkInput([rev]);
    const weakened = rev.raw.replace("status: active", "status: tentative");
    expect(validatePlannedMutation(replace("ENRICH", rev, weakened), { input, turns })).toEqual([]);
    const superseded = rev.raw.replace("status: active", "status: superseded");
    expect(codes(validatePlannedMutation(replace("ENRICH", rev, superseded), { input, turns }))).toEqual([PLAN_ISSUE.STATUS_TRANSITION_FORBIDDEN]);
    const retyped = rev.raw.replace("type: idea", "type: decision");
    expect(codes(validatePlannedMutation(replace("ENRICH", rev, retyped), { input, turns }))).toEqual([PLAN_ISSUE.TYPE_CHANGE_FORBIDDEN]);
  });

  test("(e) superseded / archived / resolved targets need a proposal", () => {
    for (const status of ["superseded", "archived", "resolved"] as const) {
      const n = plannerNote("knowledge/old-idea.md", { title: "Old idea", status, sections: { Claim: "was true once" } });
      const input = mkInput([n]);
      const content = n.raw + "\n## Evidence\nmore\nSource: conversation://s/1\n";
      expect(codes(validatePlannedMutation(replace("ENRICH", n, content), { input, turns }))).toEqual([PLAN_ISSUE.PROPOSAL_REQUIRED]);
    }
  });

  test("(f) new grounding must pass the grounding validator; CREATE claims must be grounded", () => {
    const rev = plannerNote("knowledge/reversibility-enables-agent-autonomy.md", REV);
    const input = mkInput([rev]);
    const fromAssistant = rev.raw + "\n## Evidence\nclaimed by the assistant\nSource: conversation://s/2\n";
    expect(codes(validatePlannedMutation(replace("ENRICH", rev, fromAssistant), { input, turns }))).toEqual([PLAN_ISSUE.UNGROUNDED]);
    const lowContent = rev.raw + "\n## Evidence\nconfirmed\nSource: conversation://s/3\n";
    expect(codes(validatePlannedMutation(replace("ENRICH", rev, lowContent), { input, turns }))).toEqual([PLAN_ISSUE.UNGROUNDED]);
    const unknownTurn = rev.raw + "\n## Evidence\nsomewhere\nSource: conversation://s/99\n";
    expect(codes(validatePlannedMutation(replace("ENRICH", rev, unknownTurn), { input, turns }))).toEqual([PLAN_ISSUE.UNGROUNDED]);
    const malformed = rev.raw + "\n## Evidence\nsomewhere\nSource: http://example.com\n";
    expect(codes(validatePlannedMutation(replace("ENRICH", rev, malformed), { input, turns }))).toEqual([PLAN_ISSUE.UNGROUNDED]);

    const createOk = mut("CREATE", [absent("cheap-undo")], [
      { path: "knowledge/cheap-undo.md", content: noteMd({ title: "Cheap undo", sections: { Claim: "Undo is cheap.\nGrounded-in: document://paper-1#s2" } }) },
    ]);
    expect(validatePlannedMutation(createOk, { input, turns })).toEqual([]);
    const createUngrounded = mut("CREATE", [absent("cheap-undo")], [
      { path: "knowledge/cheap-undo.md", content: noteMd({ title: "Cheap undo", sections: { Claim: "Undo is cheap." } }) },
    ]);
    expect(codes(validatePlannedMutation(createUngrounded, { input, turns }))).toEqual([PLAN_ISSUE.UNGROUNDED]);
  });

  test("(f) ADDITIVE_EVOLVE needs a new, sourced Evolution entry and keeps old entries", () => {
    const rev = plannerNote("knowledge/reversibility-enables-agent-autonomy.md", REV);
    const input = mkInput([rev]);
    const oldEvo = "### 2026-01-01 — tentative\nEarlier framing.\nSource: conversation://old-session/9";
    const withSource = rev.raw.replace(oldEvo, `${oldEvo}\n\n### 2026-09-29 — tentative\nAfter-the-fact review is enough.\nSource: conversation://s/4`);
    expect(validatePlannedMutation(replace("ADDITIVE_EVOLVE", rev, withSource), { input, turns })).toEqual([]);
    const noSource = rev.raw.replace(oldEvo, `${oldEvo}\n\n### 2026-09-29 — tentative\nAfter-the-fact review is enough.`);
    expect(codes(validatePlannedMutation(replace("ADDITIVE_EVOLVE", rev, noSource), { input, turns }))).toEqual([PLAN_ISSUE.UNGROUNDED_EVOLUTION]);
    expect(codes(validatePlannedMutation(replace("ADDITIVE_EVOLVE", rev, rev.raw), { input, turns }))).toEqual([PLAN_ISSUE.UNGROUNDED_EVOLUTION]);
    // Relabelling the op does not launder an unsourced entry; a CREATE's entries need sources too.
    expect(codes(validatePlannedMutation(replace("ENRICH", rev, noSource), { input, turns }))).toEqual([PLAN_ISSUE.UNGROUNDED_EVOLUTION]);
    expect(codes(validatePlannedMutation(replace("LINK", rev, noSource), { input, turns }))).toEqual([PLAN_ISSUE.UNGROUNDED_EVOLUTION]);
    expect(validatePlannedMutation(replace("ENRICH", rev, rev.raw), { input, turns })).toEqual([]);
    const createEvo = mut("CREATE", [absent("cheap-undo")], [
      { path: "knowledge/cheap-undo.md", content: noteMd({ title: "Cheap undo", sections: { Claim: "Undo is cheap.\nGrounded-in: conversation://s/1", Evolution: "### 2026-09-29 — tentative\nunsourced" } }) },
    ]);
    expect(codes(validatePlannedMutation(createEvo, { input, turns }))).toEqual([PLAN_ISSUE.UNGROUNDED_EVOLUTION]);
    const rewritten = rev.raw.replace(oldEvo, "### 2026-09-29 — tentative\nReplaced history.\nSource: conversation://s/4");
    expect(codes(validatePlannedMutation(replace("ADDITIVE_EVOLVE", rev, rewritten), { input, turns }))).toEqual([PLAN_ISSUE.EVOLUTION_REWRITE]);
  });

  test("(g) inference must be marked", () => {
    const rev = plannerNote("knowledge/reversibility-enables-agent-autonomy.md", REV);
    const input = mkInput([rev]);
    const unmarked = rev.raw + "\n## Agent inference\nReversibility reduces the need for pre-approval.\n";
    expect(codes(validatePlannedMutation(replace("ENRICH", rev, unmarked), { input, turns }))).toEqual([PLAN_ISSUE.UNMARKED_INFERENCE]);
    const marked = rev.raw + "\n## Agent inference\nReversibility reduces the need for pre-approval.\nInferred-from: conversation://s/2\n";
    expect(validatePlannedMutation(replace("ENRICH", rev, marked), { input, turns })).toEqual([]);
  });

  test("(h) new links must resolve (slug, alias, or sibling CREATE); typed edges use the vocabulary", () => {
    const rev = plannerNote("knowledge/reversibility-enables-agent-autonomy.md", REV);
    const safe = plannerNote("knowledge/safe-agent-changes.md", SAFE);
    const input = mkInput([rev, safe]);
    // The pre-existing dangling [[never-existed]] is not the planner's doing.
    expect(validatePlannedMutation(replace("LINK", rev, rev.raw), { input, turns })).toEqual([]);
    const dangling = rev.raw.replace("- related [[never-existed]]", "- related [[never-existed]]\n- extends [[not-a-note]]");
    expect(codes(validatePlannedMutation(replace("LINK", rev, dangling), { input, turns }))).toEqual([PLAN_ISSUE.DANGLING_LINK_ADDED]);
    const viaAlias = rev.raw.replace("- related [[never-existed]]", "- related [[never-existed]]\n- extends [[Git as a trust layer]]");
    expect(validatePlannedMutation(replace("LINK", rev, viaAlias), { input, turns })).toEqual([]);
    const sibling = rev.raw.replace("- related [[never-existed]]", "- related [[never-existed]]\n- extends [[cheap-undo]]");
    expect(codes(validatePlannedMutation(replace("LINK", rev, sibling), { input, turns }))).toEqual([PLAN_ISSUE.DANGLING_LINK_ADDED]);
    expect(validatePlannedMutation(replace("LINK", rev, sibling), { input, turns, siblingAbsentSlugs: ["cheap-undo"] })).toEqual([]);
    const badRel = rev.raw.replace("- related [[never-existed]]", "- related [[never-existed]]\n- refutes [[safe-agent-changes]]");
    expect(codes(validatePlannedMutation(replace("LINK", rev, badRel), { input, turns }))).toEqual([PLAN_ISSUE.UNKNOWN_RELATIONSHIP]);
    // Bare body link is "related" and fine; self-link resolves. Appended to the Claim, not inserted.
    const body = rev.raw.replace("Grounded-in: conversation://old-session/7", "Grounded-in: conversation://old-session/7\nSee [[safe-agent-changes]] and [[reversibility-enables-agent-autonomy]].");
    expect(validatePlannedMutation(replace("ENRICH", rev, body), { input, turns })).toEqual([]);
  });

  test("(i) rewriting the Claim is CLAIM_REWRITE; appending is fine", () => {
    const rev = plannerNote("knowledge/reversibility-enables-agent-autonomy.md", REV);
    const input = mkInput([rev]);
    const rewritten = rev.raw.replace("Reversible state transitions let", "Irreversible state transitions prevent");
    expect(codes(validatePlannedMutation(replace("ENRICH", rev, rewritten), { input, turns }))).toEqual([PLAN_ISSUE.CLAIM_REWRITE]);
    const appended = rev.raw.replace("Grounded-in: conversation://old-session/7", "Grounded-in: conversation://old-session/7\nThis also holds for low-risk mutations.\nGrounded-in: conversation://s/1");
    expect(validatePlannedMutation(replace("ENRICH", rev, appended), { input, turns })).toEqual([]);
  });

  test("alias collisions with another note's slug or alias are rejected", () => {
    const rev = plannerNote("knowledge/reversibility-enables-agent-autonomy.md", REV);
    const safe = plannerNote("knowledge/safe-agent-changes.md", SAFE);
    const input = mkInput([rev, safe]);
    const collide = rev.raw.replace("status: active\n", "status: active\naliases:\n  - git as a TRUST layer\n");
    expect(codes(validatePlannedMutation(replace("ADD_ALIAS", rev, collide), { input, turns }))).toEqual([PLAN_ISSUE.ALIAS_COLLISION]);
    const collideSlug = rev.raw.replace("status: active\n", "status: active\naliases:\n  - Safe-Agent-Changes\n");
    expect(codes(validatePlannedMutation(replace("ADD_ALIAS", rev, collideSlug), { input, turns }))).toEqual([PLAN_ISSUE.ALIAS_COLLISION]);
    const fresh = rev.raw.replace("status: active\n", "status: active\naliases:\n  - Reversibility and autonomy\n");
    expect(validatePlannedMutation(replace("ADD_ALIAS", rev, fresh), { input, turns })).toEqual([]);
  });
});
