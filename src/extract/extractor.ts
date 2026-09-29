/**
 * Knowledge extractor behind a ModelProvider (spec §36–38; I-16, I-17).
 *
 * Pipeline: turns → prompt → provider.complete (exactly once) → tolerant
 * parse → validateCandidate on each → accepted / rejected split → dedupe.
 *
 * The model's output is untrusted: `parseExtractorOutput` enforces *shape*
 * only (never throws), and every semantic grounding rule is left to the
 * deterministic `validateCandidate`.
 */
import { NOTE_TYPES } from "../core/types";
import type { ConversationTurn, ExtractionCandidate, GroundingConfig, Inference, ModelProvider, NoteType, ValidationIssue } from "../core/types";
import { normalizeTurnText } from "../markdown/validate";
import { validateCandidate } from "./groundingValidator";
import { EXTRACTOR_SYSTEM_PROMPT, buildExtractorUserMessage } from "./prompts";

export const DEFAULT_EXTRACTOR_MAX_TOKENS = 4096;

export type ModelCompleteInput = Parameters<ModelProvider["complete"]>[0];

export interface ParsedExtractorOutput {
  candidates: ExtractionCandidate[];
  /** Set when the output could not be parsed at all, or when candidates were dropped. */
  parseError?: string;
}

export interface RejectedCandidate {
  candidate: ExtractionCandidate;
  issues: ValidationIssue[];
}

export interface ExtractionResult {
  accepted: ExtractionCandidate[];
  rejected: RejectedCandidate[];
  parseError?: string;
  /** Raw provider output, for logging and evals. */
  raw: string;
}

export interface ExtractOptions {
  recentTitles?: string[];
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Parsing (shape only)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function parseInferences(v: unknown): Inference[] {
  if (!Array.isArray(v)) return [];
  const out: Inference[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    if (typeof item.text !== "string" || item.text.trim() === "") continue;
    out.push({ text: item.text, basedOn: stringArray(item.basedOn) });
  }
  return out;
}

function parseLineage(v: unknown): ExtractionCandidate["lineage"] | undefined {
  if (!isRecord(v)) return undefined;
  return {
    originatedAs: typeof v.originatedAs === "string" ? v.originatedAs : "",
    groundedIn: stringArray(v.groundedIn),
    confirmedBy: typeof v.confirmedBy === "string" ? v.confirmedBy : "",
  };
}

/** Strip leading/trailing code fences and isolate the outermost `{ … }`. */
function isolateJson(text: string): string | null {
  let s = text.trim();
  // Fenced block anywhere in the text: prefer its contents.
  const fence = s.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
  if (fence && fence[1] !== undefined) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) return null;
  return s.slice(start, end + 1);
}

/**
 * Tolerant parse of extractor output. Never throws. Enforces field shapes
 * only; semantic grounding rules belong to the validator (I-17).
 */
export function parseExtractorOutput(text: string): ParsedExtractorOutput {
  const notes: string[] = [];
  const candidates: ExtractionCandidate[] = [];

  if (typeof text !== "string") {
    return { candidates, parseError: "extractor output is not a string" };
  }
  const json = isolateJson(text);
  if (json === null) {
    return { candidates, parseError: "no JSON object found in extractor output" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { candidates, parseError: `invalid JSON in extractor output: ${msg}` };
  }

  if (!isRecord(parsed)) {
    return { candidates, parseError: "extractor output is not a JSON object" };
  }
  const rawCandidates = parsed.candidates;
  if (rawCandidates === undefined || rawCandidates === null) {
    return { candidates, parseError: 'extractor output has no "candidates" array' };
  }
  if (!Array.isArray(rawCandidates)) {
    return { candidates, parseError: '"candidates" is not an array' };
  }

  rawCandidates.forEach((item, i) => {
    if (!isRecord(item)) {
      notes.push(`candidate[${i}] dropped: not an object`);
      return;
    }
    const kind = item.kind;
    if (typeof kind !== "string" || !(NOTE_TYPES as readonly string[]).includes(kind)) {
      notes.push(`candidate[${i}] dropped: unknown kind ${JSON.stringify(kind)}`);
      return;
    }
    const claim = item.claim;
    if (typeof claim !== "string" || claim.trim() === "") {
      notes.push(`candidate[${i}] dropped: missing claim`);
      return;
    }
    const candidate: ExtractionCandidate = {
      kind: kind as NoteType,
      claim: claim.trim(),
      groundedSources: stringArray(item.groundedSources),
      inferences: parseInferences(item.inferences),
    };
    const lineage = parseLineage(item.lineage);
    if (lineage) candidate.lineage = lineage;
    candidates.push(candidate);
  });

  const result: ParsedExtractorOutput = { candidates };
  if (notes.length > 0) result.parseError = notes.join("; ");
  return result;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Normalized claim text used for dedupe: lowercase, punctuation/whitespace folded. */
export function normalizeClaim(claim: string): string {
  return normalizeTurnText(claim);
}

export async function extractCandidates(
  provider: ModelProvider,
  turns: ConversationTurn[],
  config: GroundingConfig,
  opts: ExtractOptions = {},
): Promise<ExtractionResult> {
  const content = buildExtractorUserMessage(turns, { recentTitles: opts.recentTitles });
  const raw = await provider.complete({
    system: EXTRACTOR_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    maxTokens: opts.maxTokens ?? DEFAULT_EXTRACTOR_MAX_TOKENS,
  });

  const parsed = parseExtractorOutput(raw);
  const accepted: ExtractionCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of parsed.candidates) {
    const verdict = validateCandidate(candidate, turns, config);
    if (!verdict.ok) {
      rejected.push({ candidate, issues: verdict.issues });
      continue;
    }
    const key = normalizeClaim(candidate.claim);
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(candidate);
  }

  const result: ExtractionResult = { accepted, rejected, raw };
  if (parsed.parseError !== undefined) result.parseError = parsed.parseError;
  return result;
}

// ---------------------------------------------------------------------------
// Mock provider (tests and other phases)
// ---------------------------------------------------------------------------

export type MockResponder = (input: ModelCompleteInput) => string;

/**
 * Scripted ModelProvider. Given an array, responses are consumed in order and
 * an error is thrown once exhausted (so "called exactly once" is a hard
 * check). Given a function, it is invoked per call. Every call is recorded.
 */
export class MockModelProvider implements ModelProvider {
  readonly calls: ModelCompleteInput[] = [];
  private readonly queue: string[] | null;
  private readonly responder: MockResponder | null;

  constructor(responses: string[] | MockResponder) {
    if (typeof responses === "function") {
      this.responder = responses;
      this.queue = null;
    } else {
      this.responder = null;
      this.queue = [...responses];
    }
  }

  async complete(input: ModelCompleteInput): Promise<string> {
    this.calls.push(input);
    if (this.responder) return this.responder(input);
    const next = this.queue!.shift();
    if (next === undefined) {
      throw new Error(`MockModelProvider: no scripted response left (call #${this.calls.length})`);
    }
    return next;
  }
}
