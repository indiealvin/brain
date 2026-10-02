/**
 * Knowledge maintenance for one conversation turn (spec §36; design §3, §4,
 * §17).
 *
 *   turns → extractCandidates (grounding-validated) → per candidate:
 *   buildPlannerInput → planCandidate → coord.submit(mutation) |
 *   coord.submitProposal(proposal) → reconcileIndex → ensureEmbeddings.
 *
 * This runs *after* the reply has been produced and never blocks it. Model
 * and parse problems are reported in `errors[]` / `dropped[]`; only
 * programmer errors propagate. Progress is emitted as `KnowledgeEvent`s so a
 * UI can render "Knowledge updated · N notes" when it arrives.
 */
import type {
  BrainConfig,
  ConversationTurn,
  EmbeddingProvider,
  ExecutionResult,
  ExtractionCandidate,
  ModelProvider,
  MutationState,
  MutationType,
  Proposal,
  RepoCoordinator,
} from "../core/types";
import { extractCandidates } from "../extract/extractor";
import { allNotes } from "../index/queries";
import type { IndexDb } from "../index/schema";
import { buildPlannerInput } from "../plan/context";
import { planCandidate } from "../plan/planner";
import { ensureEmbeddings } from "../retrieval/embeddings";

export interface KnowledgeMutationReport {
  mutationId: string;
  type: MutationType;
  state: MutationState;
  summary: string;
  error?: string;
}

export interface KnowledgeProposalReport {
  proposalId: string;
  operation: Proposal["operation"];
  targets: string[];
}

export interface KnowledgeUpdate {
  candidates: { accepted: number; rejected: number };
  mutations: KnowledgeMutationReport[];
  proposals: KnowledgeProposalReport[];
  dropped: { reason: string }[];
  /** True when nothing reached the repo: no commit and no proposal. */
  noop: boolean;
  errors: string[];
}

export type KnowledgeEvent =
  | { type: "extracted"; accepted: number; rejected: number; parseError?: string }
  | { type: "planned"; candidate: ExtractionCandidate; mutations: number; proposals: number; dropped: number; parseError?: string }
  | { type: "mutation"; mutation: KnowledgeMutationReport }
  | { type: "proposal"; proposal: KnowledgeProposalReport }
  | { type: "error"; message: string; candidate?: ExtractionCandidate }
  | { type: "done"; update: KnowledgeUpdate };

export interface KnowledgeDeps {
  coord: RepoCoordinator;
  db: IndexDb;
  model: ModelProvider;
  embeddings: EmbeddingProvider;
  config: BrainConfig;
  /** YYYY-MM-DD */
  today: string;
  log?: (e: KnowledgeEvent) => void;
}

export interface ProcessTurnOptions {
  /** Trailing turns handed to the extractor. Default 8. */
  window?: number;
  /** Titles shown to the extractor to discourage duplicates. Default: first 50 indexed notes. */
  recentTitles?: string[];
}

export const DEFAULT_EXTRACTOR_WINDOW = 8;
export const DEFAULT_RECENT_TITLES = 50;

/** Landed on the agent branch (and possibly main). Counted as "knowledge updated". */
const LANDED_STATES = new Set<MutationState>(["COMMITTED", "INTEGRATED"]);

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Programmer errors (wrong types, assertion-like failures) are rethrown; a
 * model, network, git or parse problem is reported and processing continues.
 */
function isProgrammerError(e: unknown): boolean {
  return e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError;
}

function reportOf(mutation: { mutationId: string; type: MutationType; summary: string }, r: ExecutionResult): KnowledgeMutationReport {
  const out: KnowledgeMutationReport = { mutationId: mutation.mutationId, type: mutation.type, state: r.state, summary: mutation.summary };
  if (r.error) out.error = r.error;
  return out;
}

export async function processTurnForKnowledge(deps: KnowledgeDeps, turns: ConversationTurn[], opts: ProcessTurnOptions = {}): Promise<KnowledgeUpdate> {
  const { coord, db, model, embeddings, config, today } = deps;
  const log = deps.log ?? (() => undefined);
  const update: KnowledgeUpdate = { candidates: { accepted: 0, rejected: 0 }, mutations: [], proposals: [], dropped: [], noop: true, errors: [] };
  const fail = (message: string, candidate?: ExtractionCandidate) => {
    update.errors.push(message);
    log(candidate ? { type: "error", message, candidate } : { type: "error", message });
  };

  // Embeddings are cheap and idempotent; retrieval below assumes they exist.
  try {
    await ensureEmbeddings(db, embeddings);
  } catch (e) {
    if (isProgrammerError(e)) throw e;
    fail(`embeddings: ${errorMessage(e)}`);
  }

  const window = Math.max(1, opts.window ?? DEFAULT_EXTRACTOR_WINDOW);
  const windowTurns = turns.slice(Math.max(0, turns.length - window));
  const recentTitles = opts.recentTitles ?? allNotes(db).slice(0, DEFAULT_RECENT_TITLES).map((n) => n.title);

  let accepted: ExtractionCandidate[] = [];
  try {
    const extraction = await extractCandidates(model, windowTurns, config.grounding, { recentTitles });
    accepted = extraction.accepted;
    update.candidates = { accepted: extraction.accepted.length, rejected: extraction.rejected.length };
    for (const r of extraction.rejected) update.dropped.push({ reason: `candidate rejected: ${r.issues.map((i) => `${i.code}: ${i.message}`).join("; ")}` });
    if (extraction.parseError !== undefined) update.errors.push(`extractor: ${extraction.parseError}`);
    log({ type: "extracted", accepted: extraction.accepted.length, rejected: extraction.rejected.length, ...(extraction.parseError !== undefined ? { parseError: extraction.parseError } : {}) });
  } catch (e) {
    if (isProgrammerError(e)) throw e;
    fail(`extractor: ${errorMessage(e)}`);
  }

  for (const candidate of accepted) {
    try {
      const input = await buildPlannerInput({ coord, db, embeddings, today }, candidate, windowTurns);
      const plan = await planCandidate(model, input);
      for (const d of plan.dropped) update.dropped.push({ reason: d.reason });
      if (plan.parseError !== undefined) update.errors.push(`planner: ${plan.parseError}`);
      log({ type: "planned", candidate, mutations: plan.mutations.length, proposals: plan.proposals.length, dropped: plan.dropped.length, ...(plan.parseError !== undefined ? { parseError: plan.parseError } : {}) });

      for (const m of plan.mutations) {
        // REPLAN / FAILED states are reported as-is; the next turn re-plans against fresh state.
        let r: ExecutionResult;
        try {
          r = await coord.submit(m);
        } catch (e) {
          if (isProgrammerError(e)) throw e;
          r = { mutationId: m.mutationId, state: "FAILED", error: errorMessage(e) };
          update.errors.push(`submit ${m.mutationId}: ${errorMessage(e)}`);
        }
        const report = reportOf(m, r);
        update.mutations.push(report);
        log({ type: "mutation", mutation: report });
      }
      for (const p of plan.proposals) {
        await coord.submitProposal(p);
        const report: KnowledgeProposalReport = { proposalId: p.proposalId, operation: p.operation, targets: p.targets.map((t) => t.path) };
        update.proposals.push(report);
        log({ type: "proposal", proposal: report });
      }
    } catch (e) {
      if (isProgrammerError(e)) throw e;
      fail(`candidate ${JSON.stringify(candidate.claim.slice(0, 80))}: ${errorMessage(e)}`, candidate);
    }
  }

  if (update.mutations.length > 0 || update.proposals.length > 0) {
    try {
      await coord.reconcileIndex();
      await ensureEmbeddings(db, embeddings);
    } catch (e) {
      if (isProgrammerError(e)) throw e;
      fail(`reconcile: ${errorMessage(e)}`);
    }
  }

  update.noop = !update.mutations.some((m) => LANDED_STATES.has(m.state)) && update.proposals.length === 0;
  log({ type: "done", update });
  return update;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const VERB: Record<MutationType, string> = {
  CREATE: "created",
  ENRICH: "enriched",
  LINK: "linked",
  ADD_ALIAS: "aliased",
  ADDITIVE_EVOLVE: "evolved",
  ARCHIVE: "archived",
  RECONCILE_EVOLUTION: "reconciled",
  MERGE: "merged",
  DELETE: "deleted",
  RENAME_SLUG: "renamed",
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * One-line summary for a UI, e.g.
 * `Knowledge updated · 2 notes (1 created, 1 enriched) · 1 proposal`,
 * `Knowledge unchanged`, or `Knowledge unchanged · 1 error`. A `NOOP`
 * mutation is "nothing to change" (I-3) and is never listed as not applied.
 */
export function formatKnowledgeSummary(u: KnowledgeUpdate): string {
  const landed = u.mutations.filter((m) => LANDED_STATES.has(m.state));
  const parts: string[] = [];
  if (landed.length > 0) {
    const byVerb = new Map<string, number>();
    for (const m of landed) byVerb.set(VERB[m.type], (byVerb.get(VERB[m.type]) ?? 0) + 1);
    const detail = [...byVerb.entries()].map(([verb, n]) => `${n} ${verb}`).join(", ");
    parts.push(`${plural(landed.length, "note")} (${detail})`);
  }
  if (u.proposals.length > 0) parts.push(plural(u.proposals.length, "proposal"));
  const head = parts.length > 0 ? `Knowledge updated · ${parts.join(" · ")}` : "Knowledge unchanged";
  // NOOP means "nothing to change" (I-3): it is neither landed nor a failure, so it is not listed.
  const notApplied = u.mutations.filter((m) => !LANDED_STATES.has(m.state) && m.state !== "NOOP");
  const extras: string[] = [];
  if (notApplied.length > 0) extras.push(`${notApplied.length} not applied (${notApplied.map((m) => m.state).join(", ")})`);
  if (u.errors.length > 0) extras.push(plural(u.errors.length, "error"));
  return extras.length > 0 ? `${head} · ${extras.join(" · ")}` : head;
}
