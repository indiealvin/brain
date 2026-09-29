import { describe, test, expect } from "bun:test";
import type { ConversationTurn, ExtractionCandidate, GroundingConfig } from "../../src/core/types";
import { MockModelProvider, extractCandidates, normalizeClaim, parseExtractorOutput } from "../../src/extract/extractor";
import { EXTRACTOR_SYSTEM_PROMPT, buildExtractorUserMessage } from "../../src/extract/prompts";

const config: GroundingConfig = { lowContentMaxTokens: 4, confirmationLexicon: ["yes", "exactly", "yeah exactly"] };

// 1 user (substantive) → 2 assistant (inference) → 3 user (low-content confirmation) → 4 user (substantive)
const turns: ConversationTurn[] = [
  { sessionId: "abc", turnId: "40", role: "user", text: "Reversibility in git makes me comfortable delegating changes to agents." },
  { sessionId: "abc", turnId: "41", role: "assistant", text: "So reversibility increases the autonomy you are willing to grant?" },
  { sessionId: "abc", turnId: "42", role: "user", text: "Yeah exactly." },
  { sessionId: "abc", turnId: "43", role: "user", text: "And cheap rollback lowers the cost of every agent mistake considerably." },
];

const U40 = "conversation://abc/40";
const A41 = "conversation://abc/41";
const U42 = "conversation://abc/42";
const U43 = "conversation://abc/43";

const json = (candidates: unknown[]) => JSON.stringify({ candidates });
const codes = (issues: { code: string }[]) => issues.map((i) => i.code).sort();

const grounded = (claim: string, sources: string[], extra: Partial<ExtractionCandidate> = {}) => ({
  kind: "idea",
  claim,
  groundedSources: sources,
  inferences: [],
  ...extra,
});

describe("prompts", () => {
  test("system prompt is a constant string, identical across reads, and states the rules", () => {
    const a = EXTRACTOR_SYSTEM_PROMPT;
    const b = EXTRACTOR_SYSTEM_PROMPT;
    expect(a).toBe(b);
    expect(typeof a).toBe("string");
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no dates/timestamps
    expect(a).toContain("conversation://<session>/<turn>");
    expect(a).toContain("ONLY user turns may appear in groundedSources");
    expect(a).toContain("agent-inference://conversation/<session>/<assistant turn>");
    expect(a).toContain("confirmedBy");
    expect(a).toContain("inferences[]");
    expect(a).toContain("basedOn");
    expect(a).toContain('{"candidates": [');
    expect(a).toContain("When in doubt, extract nothing");
    expect(a).toContain("no code fences");
    for (const kind of ["idea", "decision", "hypothesis", "question", "observation", "reference"]) {
      expect(a).toContain(`"${kind}"`);
    }
  });

  test("user message renders each turn once with URI + role, and recent titles", () => {
    const msg = buildExtractorUserMessage(turns, { recentTitles: ["Reversibility and delegation", "  "] });
    expect(msg).toContain(`1. [${U40}] user: Reversibility in git`);
    expect(msg).toContain(`2. [${A41}] assistant: So reversibility`);
    expect(msg).toContain(`3. [${U42}] user: Yeah exactly.`);
    expect(msg).toContain(`4. [${U43}] user: And cheap rollback`);
    for (const uri of [U40, A41, U42, U43]) {
      expect(msg.split(`[${uri}]`).length - 1).toBe(1);
    }
    expect(msg).toContain("- Reversibility and delegation");
    expect(msg).not.toContain("-   ");
    expect(msg).toContain('{"candidates": [...]}');
  });

  test("user message without titles omits the titles section; empty transcript is rendered", () => {
    const msg = buildExtractorUserMessage(turns);
    expect(msg).not.toContain("Recent knowledge titles");
    expect(buildExtractorUserMessage([])).toContain("(empty)");
  });

  test("assistant text never appears where grounding is instructed", () => {
    // The system prompt never labels assistant turns as valid grounding; the
    // only assistant mention near groundedSources is a prohibition.
    const groundingSection = EXTRACTOR_SYSTEM_PROMPT.slice(EXTRACTOR_SYSTEM_PROMPT.indexOf("## Grounding rules"), EXTRACTOR_SYSTEM_PROMPT.indexOf("## Duplicates"));
    expect(groundingSection).toContain("Never put an assistant turn URI in groundedSources");
    // Every groundedSources example in the prompt uses user-turn placeholders only.
    const examples = EXTRACTOR_SYSTEM_PROMPT.match(/"groundedSources": \[[^\]]*\]/g) ?? [];
    expect(examples.length).toBeGreaterThan(0);
    for (const ex of examples) {
      expect(ex).toContain("<user turn>");
      expect(ex).not.toContain("<assistant turn>");
    }
    // The user message labels assistant lines with the role so the model can tell them apart.
    const msg = buildExtractorUserMessage(turns);
    expect(msg).toMatch(new RegExp(`\\[${A41.replace(/[/.]/g, "\\$&")}\\] assistant:`));
  });
});

describe("parseExtractorOutput", () => {
  test("plain JSON", () => {
    const r = parseExtractorOutput(json([grounded("A", [U40])]));
    expect(r.parseError).toBeUndefined();
    expect(r.candidates).toEqual([{ kind: "idea", claim: "A", groundedSources: [U40], inferences: [] }]);
  });

  test("code-fenced JSON and prose-wrapped JSON are parsed leniently", () => {
    const fenced = "```json\n" + json([grounded("A", [U40])]) + "\n```";
    expect(parseExtractorOutput(fenced).candidates).toHaveLength(1);
    const prose = "Here is what I found:\n\n" + json([grounded("A", [U40])]) + "\n\nLet me know if you want more.";
    expect(parseExtractorOutput(prose).candidates).toHaveLength(1);
  });

  test("malformed input sets parseError and never throws", () => {
    for (const bad of ["", "no json here", "{not json", "[1,2,3]", '{"candidates": "nope"}', '{"foo": 1}', "42"]) {
      const r = parseExtractorOutput(bad);
      expect(r.candidates).toEqual([]);
      expect(typeof r.parseError).toBe("string");
    }
    // @ts-expect-error runtime tolerance for non-strings
    expect(parseExtractorOutput(undefined).candidates).toEqual([]);
  });

  test("unknown kind and missing claim are dropped with a note; others kept", () => {
    const r = parseExtractorOutput(json([{ kind: "poem", claim: "X", groundedSources: [U40] }, { kind: "idea", groundedSources: [U40] }, "junk", grounded("Kept", [U40])]));
    expect(r.candidates.map((c) => c.claim)).toEqual(["Kept"]);
    expect(r.parseError).toContain('unknown kind "poem"');
    expect(r.parseError).toContain("missing claim");
    expect(r.parseError).toContain("not an object");
  });

  test("missing arrays default to []; non-string entries filtered; lineage coerced and passed through", () => {
    const r = parseExtractorOutput(
      json([
        { kind: "decision", claim: "D" },
        { kind: "idea", claim: "I", groundedSources: [U40, 7, null], inferences: [{ text: "t", basedOn: [U40, 1] }, { basedOn: [] }, "x"] },
        { kind: "idea", claim: "L", lineage: { originatedAs: `agent-inference://conversation/abc/41`, groundedIn: [U40], confirmedBy: U42 } },
        { kind: "idea", claim: "P", lineage: { groundedIn: "bad" } },
      ]),
    );
    expect(r.parseError).toBeUndefined();
    expect(r.candidates[0]).toEqual({ kind: "decision", claim: "D", groundedSources: [], inferences: [] });
    expect(r.candidates[1]).toEqual({ kind: "idea", claim: "I", groundedSources: [U40], inferences: [{ text: "t", basedOn: [U40] }] });
    expect(r.candidates[2]!.lineage).toEqual({ originatedAs: "agent-inference://conversation/abc/41", groundedIn: [U40], confirmedBy: U42 });
    expect(r.candidates[3]!.lineage).toEqual({ originatedAs: "", groundedIn: [], confirmedBy: "" });
    expect("lineage" in r.candidates[0]!).toBe(false);
  });
});

describe("extractCandidates", () => {
  test("happy path: two candidates grounded in substantive user turns are accepted; provider called exactly once", async () => {
    const raw = json([
      grounded("Reversibility in git makes delegating to agents comfortable.", [U40], { inferences: [{ text: "reversibility → autonomy", basedOn: [U40] }] }),
      { kind: "observation", claim: "Cheap rollback lowers the cost of agent mistakes.", groundedSources: [U43], inferences: [] },
    ]);
    const mock = new MockModelProvider([raw]);
    const r = await extractCandidates(mock, turns, config, { recentTitles: ["Something"], maxTokens: 123 });
    expect(r.accepted).toHaveLength(2);
    expect(r.rejected).toEqual([]);
    expect(r.parseError).toBeUndefined();
    expect(r.raw).toBe(raw);
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0]!;
    expect(call.system).toBe(EXTRACTOR_SYSTEM_PROMPT);
    expect(call.maxTokens).toBe(123);
    expect(call.messages).toHaveLength(1);
    expect(call.messages[0]!.role).toBe("user");
    for (const uri of [U40, A41, U42, U43]) expect(call.messages[0]!.content).toContain(`[${uri}]`);
    expect(call.messages[0]!.content).toContain("- Something");
  });

  test("assistant-only grounding is rejected with ASSISTANT_GROUNDING", async () => {
    const mock = new MockModelProvider([json([grounded("From the assistant", [A41])])]);
    const r = await extractCandidates(mock, turns, config);
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toHaveLength(1);
    expect(codes(r.rejected[0]!.issues)).toEqual(["ASSISTANT_GROUNDING"]);
  });

  test("low-content confirmation in groundedSources is rejected", async () => {
    const mock = new MockModelProvider([json([grounded("Reversibility increases autonomy", [U42])])]);
    const r = await extractCandidates(mock, turns, config);
    expect(r.accepted).toEqual([]);
    expect(codes(r.rejected[0]!.issues)).toEqual(["LOW_CONTENT_SOLE_GROUNDING", "MISSING_LINEAGE"]);
  });

  test("the lineage form of a confirmed inference is accepted", async () => {
    const c = {
      kind: "hypothesis",
      claim: "Reversibility increases the autonomy the user is willing to grant.",
      groundedSources: [],
      inferences: [],
      lineage: { originatedAs: "agent-inference://conversation/abc/41", groundedIn: [U40], confirmedBy: U42 },
    };
    const mock = new MockModelProvider([json([c])]);
    const r = await extractCandidates(mock, turns, config);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toHaveLength(1);
    expect(r.accepted[0]!.lineage).toEqual(c.lineage);
  });

  test("lineage with the confirmation misplaced in groundedSources and no originatedAs is rejected, not thrown", async () => {
    const c = { kind: "idea", claim: "X", groundedSources: [U42], inferences: [], lineage: { groundedIn: [U40], confirmedBy: U42 } };
    const r = await extractCandidates(new MockModelProvider([json([c])]), turns, config);
    expect(r.accepted).toEqual([]);
    expect(codes(r.rejected[0]!.issues)).toContain("MISSING_LINEAGE");
  });

  test("malformed / fenced / prose-wrapped output", async () => {
    const good = json([grounded("A", [U40])]);
    const fenced = await extractCandidates(new MockModelProvider(["```json\n" + good + "\n```"]), turns, config);
    expect(fenced.accepted).toHaveLength(1);
    const prose = await extractCandidates(new MockModelProvider(["Sure! " + good + " Done."]), turns, config);
    expect(prose.accepted).toHaveLength(1);
    const broken = await extractCandidates(new MockModelProvider(["{candidates: [oops"]), turns, config);
    expect(broken.accepted).toEqual([]);
    expect(broken.rejected).toEqual([]);
    expect(broken.parseError).toBeDefined();
    expect(broken.raw).toBe("{candidates: [oops");
    const empty = await extractCandidates(new MockModelProvider([""]), turns, config);
    expect(empty.accepted).toEqual([]);
    expect(empty.parseError).toBeDefined();
  });

  test("unknown kind is dropped and reported in parseError; valid siblings still processed", async () => {
    const mock = new MockModelProvider([json([{ kind: "rant", claim: "X", groundedSources: [U40] }, grounded("A", [U40])])]);
    const r = await extractCandidates(mock, turns, config);
    expect(r.accepted.map((c) => c.claim)).toEqual(["A"]);
    expect(r.parseError).toContain("unknown kind");
  });

  test("duplicate claims (normalized) are deduped among accepted; first wins", async () => {
    const mock = new MockModelProvider([
      json([grounded("Cheap rollback lowers the cost of mistakes.", [U43]), grounded("  cheap ROLLBACK lowers the cost of mistakes ", [U40]), grounded("Different claim", [U40])]),
    ]);
    const r = await extractCandidates(mock, turns, config);
    expect(r.accepted.map((c) => c.claim)).toEqual(["Cheap rollback lowers the cost of mistakes.", "Different claim"]);
    expect(r.accepted[0]!.groundedSources).toEqual([U43]);
    expect(normalizeClaim("Cheap rollback, lowers!")).toBe("cheap rollback lowers");
  });

  test("provider failures propagate (transport errors are not parse errors)", async () => {
    const exhausted = new MockModelProvider([]);
    await expect(extractCandidates(exhausted, turns, config)).rejects.toThrow(/no scripted response/);
    const fn = new MockModelProvider(() => {
      throw new Error("boom");
    });
    await expect(extractCandidates(fn, turns, config)).rejects.toThrow("boom");
  });

  test("function-form mock sees the built input and defaults maxTokens", async () => {
    const mock = new MockModelProvider((input) => (input.messages[0]!.content.includes(U43) ? json([grounded("A", [U43])]) : json([])));
    const r = await extractCandidates(mock, turns, config);
    expect(r.accepted).toHaveLength(1);
    expect(mock.calls[0]!.maxTokens).toBeGreaterThan(0);
  });
});
