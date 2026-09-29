import { describe, test, expect } from "bun:test";
import type { ConversationTurn, ExtractionCandidate } from "../../src/core/types";
import { parseSourceUri, validateCandidate, validateGroundingSources } from "../../src/extract/groundingValidator";

const config = { lowContentMaxTokens: 4, confirmationLexicon: ["yes", "exactly"] };
const turns: ConversationTurn[] = [
  { sessionId: "s", turnId: "1", role: "user", text: "Reversibility in git makes me comfortable delegating changes to agents." },
  { sessionId: "s", turnId: "2", role: "assistant", text: "So reversibility increases acceptable autonomy?" },
  { sessionId: "s", turnId: "3", role: "user", text: "Yes." },
  { sessionId: "s", turnId: "4", role: "user", text: "And also cheap rollback lowers the cost of every agent mistake considerably." },
];
const codes = (v: { issues: { code: string }[] }) => v.issues.map((i) => i.code).sort();

describe("parseSourceUri", () => {
  test("grammar", () => {
    expect(parseSourceUri("conversation://s/1")).toEqual({ scheme: "conversation", sessionId: "s", turnId: "1", uri: "conversation://s/1" });
    expect(parseSourceUri("document://doc-1#p3")).toEqual({ scheme: "document", documentId: "doc-1", fragment: "p3", uri: "document://doc-1#p3" });
    expect(parseSourceUri("document://doc-1")).toEqual({ scheme: "document", documentId: "doc-1", uri: "document://doc-1" });
    expect(parseSourceUri("agent-inference://conversation/s/2")).toEqual({ scheme: "agent-inference", sessionId: "s", turnId: "2", uri: "agent-inference://conversation/s/2" });
    for (const bad of ["", "conversation://s", "conversation://s/1/2", "conversation:/s/1", "agent-inference://s/2", "document://", "http://x", "conversation://s/1 "]) {
      expect(parseSourceUri(bad)).toBeNull();
    }
  });
});

describe("validateGroundingSources", () => {
  test("one issue per bad source; mixed lists report everything", () => {
    const v = validateGroundingSources(["conversation://s/1", "conversation://s/2", "conversation://s/3", "bogus", "conversation://x/9"], turns, config);
    expect(v.ok).toBe(false);
    expect(codes(v)).toEqual(["ASSISTANT_GROUNDING", "LOW_CONTENT_SOLE_GROUNDING", "MALFORMED_SOURCE", "UNKNOWN_TURN"]);
  });
  test("empty list is EMPTY_GROUNDING", () => {
    expect(codes(validateGroundingSources([], turns, config))).toEqual(["EMPTY_GROUNDING"]);
  });
  test("documents alone are sufficient grounding", () => {
    expect(validateGroundingSources(["document://d"], turns, config)).toEqual({ ok: true, issues: [] });
  });
});

describe("validateCandidate lineage", () => {
  const base: ExtractionCandidate = { kind: "idea", claim: "c", groundedSources: ["conversation://s/1"], inferences: [] };

  test("valid lineage; confirmedBy may also appear in groundedSources without penalty", () => {
    const c = { ...base, groundedSources: ["conversation://s/1", "conversation://s/3"], lineage: { originatedAs: "agent-inference://conversation/s/2", groundedIn: ["conversation://s/1"], confirmedBy: "conversation://s/3" } };
    expect(validateCandidate(c, turns, config)).toEqual({ ok: true, issues: [] });
  });

  test("low-content confirmation without lineage adds MISSING_LINEAGE hint when it follows an assistant turn", () => {
    const v = validateCandidate({ ...base, groundedSources: ["conversation://s/3"] }, turns, config);
    expect(codes(v)).toEqual(["LOW_CONTENT_SOLE_GROUNDING", "MISSING_LINEAGE"]);
    expect(v.issues.find((i) => i.code === "MISSING_LINEAGE")?.message).toContain("agent-inference://conversation/s/2");
  });

  test("originatedAs must be an agent-inference URI naming a known assistant turn", () => {
    const mk = (originatedAs: string) => ({ ...base, lineage: { originatedAs, groundedIn: ["conversation://s/1"], confirmedBy: "conversation://s/3" } });
    expect(codes(validateCandidate(mk("conversation://s/2"), turns, config))).toEqual(["MALFORMED_SOURCE"]);
    expect(codes(validateCandidate(mk("agent-inference://conversation/s/99"), turns, config))).toEqual(["UNKNOWN_TURN"]);
    expect(codes(validateCandidate(mk("agent-inference://conversation/s/1"), turns, config))).toEqual(["INVALID_LINEAGE"]);
  });

  test("confirmedBy must be a known user turn immediately after originatedAs", () => {
    const mk = (confirmedBy: string) => ({ ...base, lineage: { originatedAs: "agent-inference://conversation/s/2", groundedIn: ["conversation://s/1"], confirmedBy } });
    expect(codes(validateCandidate(mk("conversation://s/4"), turns, config))).toEqual(["CONFIRMATION_NOT_ADJACENT"]);
    expect(codes(validateCandidate(mk("conversation://s/2"), turns, config))).toEqual(["ASSISTANT_GROUNDING"]);
    expect(codes(validateCandidate(mk("conversation://s/42"), turns, config))).toEqual(["UNKNOWN_TURN"]);
    expect(codes(validateCandidate(mk("agent-inference://conversation/s/3"), turns, config))).toEqual(["MALFORMED_SOURCE"]);
  });

  test("groundedIn is validated as grounding; incomplete lineage is MISSING_LINEAGE", () => {
    const c1 = { ...base, lineage: { originatedAs: "agent-inference://conversation/s/2", groundedIn: ["conversation://s/2"], confirmedBy: "conversation://s/3" } };
    expect(codes(validateCandidate(c1, turns, config))).toEqual(["ASSISTANT_GROUNDING"]);
    const c2 = { ...base, lineage: { originatedAs: "agent-inference://conversation/s/2", groundedIn: [], confirmedBy: "conversation://s/3" } };
    expect(codes(validateCandidate(c2, turns, config))).toEqual(["MISSING_LINEAGE"]);
    const c3 = { ...base, lineage: { originatedAs: "", groundedIn: ["conversation://s/1"], confirmedBy: "" } };
    expect(codes(validateCandidate(c3, turns, config))).toEqual(["MISSING_LINEAGE"]);
  });

  test("empty groundedSources without lineage is rejected", () => {
    expect(codes(validateCandidate({ ...base, groundedSources: [] }, turns, config))).toEqual(["EMPTY_GROUNDING"]);
  });
});
