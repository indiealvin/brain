import { describe, test, expect } from "bun:test";
import { assignNoteId, ensureTrailingNewline, materialize } from "../../src/plan/planner";
import type { PlannerInput } from "../../src/plan/context";

const input: PlannerInput = {
  candidate: { kind: "idea", claim: "c", groundedSources: ["conversation://s/1"], inferences: [] },
  turns: [{ sessionId: "s", turnId: "1", role: "user", text: "a substantive claim about things" }],
  notes: [{ noteId: "01NOTEA", path: "knowledge/a.md", slug: "a", title: "A", status: "active", type: "idea", blobHash: "h", raw: "---\nid: 01NOTEA\ncreated: 2026-01-01\ntype: idea\nstatus: active\n---\n# A\n" }],
  neighbors: [],
  pendingMutations: [],
  pendingProposals: [],
  rejectedProposals: [],
  config: { version: 1, repoId: "r", links: { relationships: ["related"] }, sync: { quiescenceMs: 1 }, grounding: { lowContentMaxTokens: 4, confirmationLexicon: [] } },
  today: "2026-09-29",
  nsKeys: new Set(["a"]),
} as PlannerInput;

describe("materialize hygiene", () => {
  test("CREATE gets a system-assigned id, replacing whatever the model wrote", () => {
    const content = "---\nid: NEW\ncreated: 2026-09-29\ntype: idea\nstatus: active\n---\n# B\n\n## Claim\nx\nGrounded-in: conversation://s/1";
    const plan = materialize(input, [{ op: "CREATE", path: "knowledge/b.md", content }]);
    expect(plan.mutations.length).toBe(1);
    const out = plan.mutations[0]!.writes[0]!.content!;
    const id = out.match(/^id: (\S+)$/m)![1]!;
    expect(id).not.toBe("NEW");
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  test("CREATE without an id line gets one inserted; ENRICH keeps the existing id", () => {
    const noId = "---\ncreated: 2026-09-29\ntype: idea\nstatus: active\n---\n# B\n";
    expect(assignNoteId(noId, "01ABCDEFGHJKMNPQRSTVWXYZ01")).toBe("---\nid: 01ABCDEFGHJKMNPQRSTVWXYZ01\ncreated: 2026-09-29\ntype: idea\nstatus: active\n---\n# B\n");
    const plan = materialize(input, [{ op: "ENRICH", noteId: "01NOTEA", content: "---\nid: 01NOTEA\ncreated: 2026-01-01\ntype: idea\nstatus: active\n---\n# A\n\n## Claim\nmore" }]);
    expect(plan.mutations[0]!.writes[0]!.content).toContain("id: 01NOTEA");
    expect(plan.mutations[0]!.writes[0]!.content!.endsWith("more\n")).toBe(true);
  });

  test("ensureTrailingNewline normalizes", () => {
    expect(ensureTrailingNewline("x")).toBe("x\n");
    expect(ensureTrailingNewline("x\n\n\n")).toBe("x\n");
    expect(ensureTrailingNewline("x\n")).toBe("x\n");
  });
});
