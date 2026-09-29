/**
 * Mutation planner behind a `ModelProvider` (spec §36, §39; I-4, I-17).
 *
 *   planCandidate = one provider.complete call
 *                 → parsePlannerOutput (lenient, never throws)
 *                 → materialize (deterministic: ops → Mutation | Proposal)
 *                 → validatePlannedMutation on every mutation
 *
 * Everything after the model call is deterministic. Output is fully
 * materialized file contents; the executor never sees instructions.
 */
import { AUTOMATIC_MUTATION_TYPES } from "../core/types";
import type {
  AutomaticMutationType,
  FileWrite,
  ModelProvider,
  Mutation,
  Proposal,
  ProposalMutationType,
  TargetPrecondition,
  ValidationIssue,
} from "../core/types";
import { mutationId as newMutationId, proposalId as newProposalId } from "../core/ids";
import { isNotePath, slugFromPath, slugKey } from "../core/slug";
import { NoteParseError, parseNote } from "../markdown/parse";
import type { PlannerInput, PlannerNote } from "./context";
import { validatePlannedMutation } from "./mutationValidator";
import { PLANNER_SYSTEM_PROMPT, buildPlannerUserMessage } from "./prompts";

export const PROPOSAL_OP_TYPES: readonly ProposalMutationType[] = ["RECONCILE_EVOLUTION", "MERGE", "ARCHIVE", "DELETE", "RENAME_SLUG"];

export type PlannedOp =
  | { op: "CREATE"; path: string; content: string; reasoning?: string }
  | { op: Exclude<AutomaticMutationType, "CREATE">; noteId: string; content: string; reasoning?: string }
  | { op: ProposalMutationType; noteIds: string[]; writes: FileWrite[]; reasoning?: string; evidence?: string[] };

export interface ParsedPlan {
  operations: PlannedOp[];
  parseError?: string;
}

export interface DroppedOp {
  op?: PlannedOp;
  mutation?: Mutation;
  reason: string;
  issues?: ValidationIssue[];
}

export interface MaterializedPlan {
  mutations: Mutation[];
  proposals: Proposal[];
  dropped: DroppedOp[];
}

export interface PlanResult extends MaterializedPlan {
  raw: string;
  parseError?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) if (typeof x === "string") out.push(x);
  return out;
}

/** Strip code fences and isolate the outermost `{ … }`. */
function extractJsonObject(text: string): string | null {
  let s = text.trim();
  const fenced = s.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);
  if (fenced) s = fenced[1]!.trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  return s.slice(start, end + 1);
}

function coerceOp(raw: unknown): PlannedOp | null {
  if (!isRecord(raw)) return null;
  const op = str(raw["op"])?.trim().toUpperCase();
  if (!op) return null;
  const reasoning = str(raw["reasoning"]);
  const withReasoning = <T extends object>(o: T): T & { reasoning?: string } => (reasoning !== undefined ? { ...o, reasoning } : o);

  if (op === "CREATE") {
    const path = str(raw["path"]);
    const content = str(raw["content"]);
    if (!path || content === undefined) return null;
    return withReasoning({ op: "CREATE" as const, path: path.trim(), content });
  }
  if ((AUTOMATIC_MUTATION_TYPES as readonly string[]).includes(op)) {
    const noteId = str(raw["noteId"]);
    const content = str(raw["content"]);
    if (!noteId || content === undefined) return null;
    return withReasoning({ op: op as Exclude<AutomaticMutationType, "CREATE">, noteId: noteId.trim(), content });
  }
  if ((PROPOSAL_OP_TYPES as readonly string[]).includes(op)) {
    const noteIds = stringList(raw["noteIds"]) ?? (str(raw["noteId"]) ? [str(raw["noteId"])!] : undefined);
    if (!noteIds || noteIds.length === 0) return null;
    const writesRaw = raw["writes"];
    if (!Array.isArray(writesRaw)) return null;
    const writes: FileWrite[] = [];
    for (const w of writesRaw) {
      if (!isRecord(w)) return null;
      const path = str(w["path"]);
      const content = w["content"];
      if (!path || !(typeof content === "string" || content === null)) return null;
      writes.push({ path: path.trim(), content });
    }
    const evidence = stringList(raw["evidence"]);
    const out: PlannedOp = { op: op as ProposalMutationType, noteIds: noteIds.map((s) => s.trim()), writes };
    if (evidence) out.evidence = evidence;
    return withReasoning(out);
  }
  return null;
}

/**
 * Lenient parse of planner output: tolerates code fences and surrounding
 * prose, drops malformed operations, never throws. `parseError` is set when
 * no usable JSON object was found.
 */
export function parsePlannerOutput(text: string): ParsedPlan {
  const body = extractJsonObject(text ?? "");
  if (body === null) return { operations: [], parseError: "no JSON object found in planner output" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return { operations: [], parseError: `invalid JSON: ${(e as Error).message}` };
  }
  if (!isRecord(parsed)) return { operations: [], parseError: "planner output is not a JSON object" };
  const opsRaw = parsed["operations"];
  if (opsRaw === undefined || opsRaw === null) return { operations: [] };
  if (!Array.isArray(opsRaw)) return { operations: [], parseError: '"operations" is not an array' };
  const operations: PlannedOp[] = [];
  for (const raw of opsRaw) {
    const op = coerceOp(raw);
    if (op) operations.push(op);
  }
  return { operations };
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

function titleOf(content: string, path: string): string {
  try {
    const t = parseNote(path, content).title.trim();
    if (t !== "") return t;
  } catch (e) {
    if (!(e instanceof NoteParseError)) throw e;
  }
  const m = content.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1]!.trim() : slugFromPath(path);
}

function candidateEvidence(input: PlannerInput): string[] {
  const c = input.candidate;
  const out: string[] = [];
  const add = (u: string) => {
    if (u && !out.includes(u)) out.push(u);
  };
  for (const u of c.groundedSources) add(u);
  if (c.lineage) {
    add(c.lineage.originatedAs);
    for (const u of c.lineage.groundedIn) add(u);
    add(c.lineage.confirmedBy);
  }
  return out;
}

function todayIso(today: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(today) ? `${today}T00:00:00.000Z` : new Date().toISOString();
}

/**
 * Deterministically turn parsed operations into `Mutation`s (automatic ops)
 * and `Proposal`s (proposal ops). Ops that cannot be bound to the planner
 * input are dropped with a reason. No validation beyond binding happens
 * here; see `validatePlannedMutation`.
 */
export function materialize(input: PlannerInput, ops: PlannedOp[]): MaterializedPlan {
  const mutations: Mutation[] = [];
  const proposals: Proposal[] = [];
  const dropped: DroppedOp[] = [];
  const byId = new Map<string, PlannerNote>();
  for (const n of input.notes) byId.set(n.noteId, n);
  const evidence = candidateEvidence(input);
  const createdKeys = new Set<string>();
  const createdAt = todayIso(input.today);

  for (const op of ops) {
    if (op.op === "CREATE") {
      if (!isNotePath(op.path) || op.path.startsWith("/") || op.path.includes("..")) {
        dropped.push({ op, reason: `CREATE path ${JSON.stringify(op.path)} is not a repo-relative Markdown note` });
        continue;
      }
      const slug = slugFromPath(op.path);
      const key = slugKey(slug);
      if (key === "") {
        dropped.push({ op, reason: "CREATE path has an empty slug" });
        continue;
      }
      if (input.nsKeys.has(key)) {
        dropped.push({ op, reason: `slug ${JSON.stringify(slug)} collides with an existing slug or alias` });
        continue;
      }
      if (createdKeys.has(key)) {
        dropped.push({ op, reason: `slug ${JSON.stringify(slug)} is created twice in this plan` });
        continue;
      }
      createdKeys.add(key);
      const targets: TargetPrecondition[] = [{ kind: "absent", slug }];
      const m: Mutation = {
        mutationId: newMutationId(),
        type: "CREATE",
        summary: `create ${titleOf(op.content, op.path)}`,
        targets,
        writes: [{ path: op.path, content: op.content }],
        dependsOn: [],
        evidence,
      };
      if (op.reasoning) m.reasoning = op.reasoning;
      mutations.push(m);
      continue;
    }

    if ("noteId" in op) {
      const note = byId.get(op.noteId);
      if (!note) {
        dropped.push({ op, reason: `${op.op} targets noteId ${JSON.stringify(op.noteId)} which was not retrieved` });
        continue;
      }
      const m: Mutation = {
        mutationId: newMutationId(),
        type: op.op,
        summary: `${op.op.toLowerCase().replace(/_/g, " ")} ${note.title || note.slug}`,
        targets: [{ kind: "present", noteId: note.noteId, path: note.path, blobHash: note.blobHash }],
        writes: [{ path: note.path, content: op.content }],
        dependsOn: [],
        evidence,
      };
      if (op.reasoning) m.reasoning = op.reasoning;
      mutations.push(m);
      continue;
    }

    // Proposal op.
    const targets: Proposal["targets"] = [];
    let missing: string | null = null;
    const seen = new Set<string>();
    for (const id of op.noteIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const note = byId.get(id);
      if (!note) {
        missing = id;
        break;
      }
      targets.push({ noteId: note.noteId, path: note.path, blobHash: note.blobHash });
    }
    if (missing !== null) {
      dropped.push({ op, reason: `${op.op} targets noteId ${JSON.stringify(missing)} which was not retrieved` });
      continue;
    }
    const targetPaths = new Set(targets.map((t) => t.path));
    const outside = op.writes.find((w) => !targetPaths.has(w.path));
    if (outside) {
      // Proposal targets are present-only snapshots (§33); a write outside
      // them (e.g. RENAME_SLUG's new path) cannot be declared in v0.
      dropped.push({ op, reason: `${op.op} writes ${JSON.stringify(outside.path)} which is not a targeted note` });
      continue;
    }
    const proposalEvidence = [...evidence];
    for (const u of op.evidence ?? []) if (!proposalEvidence.includes(u)) proposalEvidence.push(u);
    proposals.push({
      proposalId: newProposalId(),
      mutationId: newMutationId(),
      operation: op.op,
      targets,
      writes: op.writes.map((w) => ({ path: w.path, content: w.content })),
      evidence: proposalEvidence,
      reasoning: op.reasoning ?? "",
      createdAt,
      status: "PENDING",
    });
  }

  return { mutations, proposals, dropped };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface PlanOptions {
  maxTokens?: number;
}

export const DEFAULT_PLANNER_MAX_TOKENS = 16000;

/**
 * Plan one candidate: one model call, then deterministic parse →
 * materialize → validate. Mutations failing validation move to `dropped`
 * with their issues. Provider errors propagate; malformed output does not.
 */
export async function planCandidate(provider: ModelProvider, input: PlannerInput, opts: PlanOptions = {}): Promise<PlanResult> {
  const raw = await provider.complete({
    system: PLANNER_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildPlannerUserMessage(input) }],
    maxTokens: opts.maxTokens ?? DEFAULT_PLANNER_MAX_TOKENS,
  });
  const parsed = parsePlannerOutput(raw);
  const plan = materialize(input, parsed.operations);

  const siblingAbsentSlugs: string[] = [];
  for (const m of plan.mutations) for (const t of m.targets) if (t.kind === "absent") siblingAbsentSlugs.push(t.slug);

  const mutations: Mutation[] = [];
  const dropped = [...plan.dropped];
  for (const m of plan.mutations) {
    const issues = validatePlannedMutation(m, { input, turns: input.turns, siblingAbsentSlugs });
    if (issues.length === 0) {
      mutations.push(m);
    } else {
      dropped.push({ mutation: m, reason: issues.map((i) => `${i.code}: ${i.message}`).join("; "), issues });
    }
  }

  const result: PlanResult = { mutations, proposals: plan.proposals, dropped, raw };
  if (parsed.parseError !== undefined) result.parseError = parsed.parseError;
  return result;
}
