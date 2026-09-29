/**
 * Deterministic grounding validator (spec §27–28, §38; I-16, I-17).
 *
 * Pure: no I/O, no model calls. Extractor output is untrusted until this
 * passes it.
 *
 * Issue codes:
 *   EMPTY_GROUNDING             no sources at all
 *   MALFORMED_SOURCE            URI does not match the §27 grammar
 *   UNKNOWN_TURN                conversation URI names a turn not in `turns`
 *   ASSISTANT_GROUNDING         assistant turn (or agent-inference URI) used as grounding
 *   LOW_CONTENT_SOLE_GROUNDING  a low-content user turn used as grounding
 *                               (it may only appear as lineage.confirmedBy)
 *   MISSING_LINEAGE             looks like a promoted inference but has no /
 *                               incomplete lineage
 *   INVALID_LINEAGE             lineage.originatedAs does not point at an assistant turn
 *   CONFIRMATION_NOT_ADJACENT   confirmedBy is not the turn immediately after originatedAs
 */
import type { ConversationTurn, ExtractionCandidate, GroundingConfig, GroundingVerdict, ValidationIssue } from "../core/types";
import { isLowContentTurn } from "../markdown/validate";

export type SourceRef =
  | { scheme: "conversation"; sessionId: string; turnId: string; uri: string }
  | { scheme: "document"; documentId: string; fragment?: string; uri: string }
  | { scheme: "agent-inference"; sessionId: string; turnId: string; uri: string };

const CONVERSATION_RE = /^conversation:\/\/([^\/\s#]+)\/([^\/\s#]+)$/;
const DOCUMENT_RE = /^document:\/\/([^\s#]+)(?:#(\S+))?$/;
const AGENT_INFERENCE_RE = /^agent-inference:\/\/conversation\/([^\/\s#]+)\/([^\/\s#]+)$/;

/** Parse a §27 source URI. Returns null when malformed. */
export function parseSourceUri(uri: string): SourceRef | null {
  if (typeof uri !== "string") return null;
  let m = uri.match(CONVERSATION_RE);
  if (m) return { scheme: "conversation", sessionId: m[1]!, turnId: m[2]!, uri };
  m = uri.match(AGENT_INFERENCE_RE);
  if (m) return { scheme: "agent-inference", sessionId: m[1]!, turnId: m[2]!, uri };
  m = uri.match(DOCUMENT_RE);
  if (m) {
    const ref: SourceRef = { scheme: "document", documentId: m[1]!, uri };
    if (m[2] !== undefined) ref.fragment = m[2];
    return ref;
  }
  return null;
}

function findTurnIndex(turns: ConversationTurn[], sessionId: string, turnId: string): number {
  return turns.findIndex((t) => t.sessionId === sessionId && t.turnId === turnId);
}

interface SourceCheck {
  issues: ValidationIssue[];
  /** Indices (into `turns`) of low-content user turns found among the sources. */
  lowContentTurnIndices: number[];
}

function checkSources(sources: string[], turns: ConversationTurn[], config: GroundingConfig, opts: { allowEmpty: boolean }): SourceCheck {
  const issues: ValidationIssue[] = [];
  const lowContentTurnIndices: number[] = [];
  if (sources.length === 0) {
    if (!opts.allowEmpty) issues.push({ code: "EMPTY_GROUNDING", message: "no grounding sources" });
    return { issues, lowContentTurnIndices };
  }
  for (const uri of sources) {
    const ref = parseSourceUri(uri);
    if (!ref) {
      issues.push({ code: "MALFORMED_SOURCE", message: `malformed source URI: ${JSON.stringify(uri)}` });
      continue;
    }
    if (ref.scheme === "agent-inference") {
      issues.push({ code: "ASSISTANT_GROUNDING", message: `agent inference cannot ground a claim: ${uri}` });
      continue;
    }
    if (ref.scheme === "document") continue;
    const idx = findTurnIndex(turns, ref.sessionId, ref.turnId);
    if (idx < 0) {
      issues.push({ code: "UNKNOWN_TURN", message: `unknown conversation turn: ${uri}` });
      continue;
    }
    const turn = turns[idx]!;
    if (turn.role !== "user") {
      issues.push({ code: "ASSISTANT_GROUNDING", message: `assistant turn cannot ground a claim: ${uri}` });
      continue;
    }
    if (isLowContentTurn(turn.text, config)) {
      lowContentTurnIndices.push(idx);
      issues.push({
        code: "LOW_CONTENT_SOLE_GROUNDING",
        message: `low-content user turn cannot ground a claim (may only confirm a preceding inference): ${uri}`,
      });
    }
  }
  return { issues, lowContentTurnIndices };
}

/**
 * Validate a list of grounding sources (used for candidate grounding and for
 * ADDITIVE_EVOLVE evidence). ok iff no issues.
 */
export function validateGroundingSources(sources: string[], turns: ConversationTurn[], config: GroundingConfig): GroundingVerdict {
  const { issues } = checkSources(sources, turns, config, { allowEmpty: false });
  return { ok: issues.length === 0, issues };
}

/**
 * Validate an extraction candidate, including promoted-inference lineage
 * (§28: Originated-as must be an assistant turn; Confirmed-by must be the
 * user turn immediately after it; Grounded-in must itself be valid grounding).
 */
export function validateCandidate(candidate: ExtractionCandidate, turns: ConversationTurn[], config: GroundingConfig): GroundingVerdict {
  const issues: ValidationIssue[] = [];
  const lineage = candidate.lineage;

  if (!lineage) {
    const check = checkSources(candidate.groundedSources, turns, config, { allowEmpty: false });
    issues.push(...check.issues);
    // Diagnostic: a low-content turn right after an assistant turn looks like a
    // confirmation of an inference; the candidate should carry lineage instead.
    for (const idx of check.lowContentTurnIndices) {
      const prev = idx > 0 ? turns[idx - 1] : undefined;
      if (prev && prev.role === "assistant") {
        const t = turns[idx]!;
        issues.push({
          code: "MISSING_LINEAGE",
          message:
            `conversation://${t.sessionId}/${t.turnId} confirms the preceding assistant turn; ` +
            `a promoted inference must carry lineage {originatedAs: agent-inference://conversation/${prev.sessionId}/${prev.turnId}, confirmedBy: conversation://${t.sessionId}/${t.turnId}}`,
        });
      }
    }
    return { ok: issues.length === 0, issues };
  }

  // --- lineage present ---
  const missing: string[] = [];
  if (!lineage.originatedAs) missing.push("originatedAs");
  if (!lineage.confirmedBy) missing.push("confirmedBy");
  if (!Array.isArray(lineage.groundedIn) || lineage.groundedIn.length === 0) missing.push("groundedIn");
  if (missing.length > 0) {
    issues.push({ code: "MISSING_LINEAGE", message: `incomplete lineage: missing ${missing.join(", ")}` });
  }

  let originIdx = -1;
  let originValid = false;
  if (lineage.originatedAs) {
    const origin = parseSourceUri(lineage.originatedAs);
    if (!origin || origin.scheme !== "agent-inference") {
      issues.push({ code: "MALFORMED_SOURCE", message: `lineage.originatedAs must be an agent-inference URI: ${JSON.stringify(lineage.originatedAs)}` });
    } else {
      originIdx = findTurnIndex(turns, origin.sessionId, origin.turnId);
      if (originIdx < 0) {
        issues.push({ code: "UNKNOWN_TURN", message: `lineage.originatedAs names an unknown turn: ${lineage.originatedAs}` });
      } else if (turns[originIdx]!.role !== "assistant") {
        issues.push({ code: "INVALID_LINEAGE", message: `lineage.originatedAs must point at an assistant turn: ${lineage.originatedAs}` });
      } else {
        originValid = true;
      }
    }
  }

  if (lineage.confirmedBy) {
    const conf = parseSourceUri(lineage.confirmedBy);
    if (!conf || conf.scheme !== "conversation") {
      issues.push({ code: "MALFORMED_SOURCE", message: `lineage.confirmedBy must be a conversation URI: ${JSON.stringify(lineage.confirmedBy)}` });
    } else {
      const confIdx = findTurnIndex(turns, conf.sessionId, conf.turnId);
      if (confIdx < 0) {
        issues.push({ code: "UNKNOWN_TURN", message: `lineage.confirmedBy names an unknown turn: ${lineage.confirmedBy}` });
      } else if (turns[confIdx]!.role !== "user") {
        issues.push({ code: "ASSISTANT_GROUNDING", message: `lineage.confirmedBy must be a user turn: ${lineage.confirmedBy}` });
      } else if (originValid && confIdx !== originIdx + 1) {
        issues.push({
          code: "CONFIRMATION_NOT_ADJACENT",
          message: `lineage.confirmedBy (${lineage.confirmedBy}) must be the turn immediately after originatedAs (${lineage.originatedAs})`,
        });
      }
    }
  }

  if (Array.isArray(lineage.groundedIn) && lineage.groundedIn.length > 0) {
    issues.push(...checkSources(lineage.groundedIn, turns, config, { allowEmpty: false }).issues);
  }

  // groundedSources may repeat groundedIn; the confirmation turn itself is not grounding.
  const extra = candidate.groundedSources.filter((s) => s !== lineage.confirmedBy);
  issues.push(...checkSources(extra, turns, config, { allowEmpty: true }).issues);

  return { ok: issues.length === 0, issues };
}
