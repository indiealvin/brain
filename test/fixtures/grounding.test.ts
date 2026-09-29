/**
 * Phase 8 fixtures (pure, deterministic) — grounding validator (spec §3.17, 3.18, §27–28, §38).
 * READ-ONLY for implementers.
 */
import { describe, test, expect } from "bun:test";
import type { ConversationTurn, ExtractionCandidate, GroundingConfig } from "../../src/core/types";

const config: GroundingConfig = {
  lowContentMaxTokens: 4,
  confirmationLexicon: ["yes", "yeah", "yep", "exactly", "right", "correct", "agreed", "i agree", "that's it", "that's what i mean"],
};

const turns: ConversationTurn[] = [
  { sessionId: "abc", turnId: "40", role: "user", text: "Git reversibility makes me more comfortable letting agents change things." },
  { sessionId: "abc", turnId: "41", role: "assistant", text: "So perhaps reversibility increases acceptable agent autonomy." },
  { sessionId: "abc", turnId: "42", role: "user", text: "Yeah, exactly." },
  { sessionId: "abc", turnId: "43", role: "assistant", text: "Noted." },
  { sessionId: "abc", turnId: "44", role: "user", text: "Right." },
];

const U40 = "conversation://abc/40";
const A41 = "conversation://abc/41";
const U42 = "conversation://abc/42";
const U44 = "conversation://abc/44";

function codes(v: { issues: { code: string }[] }): string[] {
  return v.issues.map((i) => i.code).sort();
}

describe("3.17 low-content confirmation cannot ground", () => {
  test("sole grounding from 'Yeah, exactly.' is rejected", async () => {
    const { validateCandidate } = await import("../../src/extract/groundingValidator");
    const c: ExtractionCandidate = { kind: "idea", claim: "Reversibility increases acceptable agent autonomy.", groundedSources: [U42], inferences: [] };
    const v = validateCandidate(c, turns, config);
    expect(v.ok).toBe(false);
    expect(codes(v)).toContain("LOW_CONTENT_SOLE_GROUNDING");
  });

  test("low-content turn may confirm the immediately preceding inference with full lineage", async () => {
    const { validateCandidate } = await import("../../src/extract/groundingValidator");
    const c: ExtractionCandidate = {
      kind: "idea",
      claim: "Reversibility increases acceptable agent autonomy.",
      groundedSources: [U40],
      inferences: [],
      lineage: { originatedAs: "agent-inference://conversation/abc/41", groundedIn: [U40], confirmedBy: U42 },
    };
    const v = validateCandidate(c, turns, config);
    expect(v.ok).toBe(true);
    expect(v.issues).toEqual([]);
  });

  test("confirmation that is not adjacent to the inference is rejected", async () => {
    const { validateCandidate } = await import("../../src/extract/groundingValidator");
    const c: ExtractionCandidate = {
      kind: "idea",
      claim: "Reversibility increases acceptable agent autonomy.",
      groundedSources: [U40],
      inferences: [],
      lineage: { originatedAs: "agent-inference://conversation/abc/41", groundedIn: [U40], confirmedBy: U44 },
    };
    const v = validateCandidate(c, turns, config);
    expect(v.ok).toBe(false);
    expect(codes(v)).toContain("CONFIRMATION_NOT_ADJACENT");
  });

  test("a promoted inference without lineage is rejected", async () => {
    const { validateCandidate } = await import("../../src/extract/groundingValidator");
    const c: ExtractionCandidate = {
      kind: "idea",
      claim: "Reversibility increases acceptable agent autonomy.",
      groundedSources: [U40, U42],
      inferences: [],
    };
    const v = validateCandidate(c, turns, config);
    // U42 is low-content: it can only appear as confirmedBy, never as a grounding source.
    expect(v.ok).toBe(false);
    expect(codes(v)).toContain("LOW_CONTENT_SOLE_GROUNDING");
  });

  test("substantive user grounding passes", async () => {
    const { validateCandidate } = await import("../../src/extract/groundingValidator");
    const c: ExtractionCandidate = { kind: "idea", claim: "Reversibility makes delegation comfortable.", groundedSources: [U40], inferences: [] };
    expect(validateCandidate(c, turns, config).ok).toBe(true);
  });
});

describe("3.18 assistant turns never ground", () => {
  test("assistant-only grounding is rejected for a candidate", async () => {
    const { validateCandidate } = await import("../../src/extract/groundingValidator");
    const c: ExtractionCandidate = { kind: "idea", claim: "Reversibility increases acceptable agent autonomy.", groundedSources: [A41], inferences: [] };
    const v = validateCandidate(c, turns, config);
    expect(v.ok).toBe(false);
    expect(codes(v)).toContain("ASSISTANT_GROUNDING");
  });

  test("ADDITIVE_EVOLVE sources drawn only from an assistant turn are rejected", async () => {
    const { validateGroundingSources } = await import("../../src/extract/groundingValidator");
    const v = validateGroundingSources([A41], turns, config);
    expect(v.ok).toBe(false);
    expect(codes(v)).toContain("ASSISTANT_GROUNDING");
    expect(validateGroundingSources([U40], turns, config).ok).toBe(true);
    expect(validateGroundingSources(["document://doc-1#p3"], turns, config).ok).toBe(true);
  });

  test("malformed or unknown sources are rejected", async () => {
    const { validateGroundingSources } = await import("../../src/extract/groundingValidator");
    expect(codes(validateGroundingSources(["not a uri"], turns, config))).toContain("MALFORMED_SOURCE");
    expect(codes(validateGroundingSources(["conversation://abc/999"], turns, config))).toContain("UNKNOWN_TURN");
    expect(codes(validateGroundingSources(["agent-inference://conversation/abc/41"], turns, config))).toContain("ASSISTANT_GROUNDING");
    expect(validateGroundingSources([], turns, config).ok).toBe(false);
  });
});
