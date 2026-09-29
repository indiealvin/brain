/**
 * Core seam for the v0 knowledge engine.
 *
 * This file is READ-ONLY for implementers. It is the contract the fixtures in
 * test/fixtures/ are written against. See docs/spec.md and docs/invariants.md.
 */

// ---------------------------------------------------------------------------
// Notes and Markdown
// ---------------------------------------------------------------------------

export type NoteType =
  | "idea"
  | "decision"
  | "hypothesis"
  | "question"
  | "observation"
  | "reference";

export type NoteStatus =
  | "active"
  | "tentative"
  | "superseded"
  | "resolved"
  | "archived";

export const NOTE_TYPES: readonly NoteType[] = [
  "idea",
  "decision",
  "hypothesis",
  "question",
  "observation",
  "reference",
];

export const NOTE_STATUSES: readonly NoteStatus[] = [
  "active",
  "tentative",
  "superseded",
  "resolved",
  "archived",
];

export interface Frontmatter {
  id: string;
  created: string; // YYYY-MM-DD
  type: NoteType;
  status: NoteStatus;
  aliases: string[];
  /** Unknown scalar keys written by humans, preserved verbatim in file order. */
  extra?: Record<string, string>;
}

export interface WikiLink {
  /** Raw target as written: slug or alias. */
  target: string;
  /** Case-insensitive normalized key of `target` (see slugKey). */
  targetKey: string;
  display?: string;
  /** "related" for bare links; the relationship word for Connections entries. */
  relationship: string;
  /** "body" | "connections" */
  section: "body" | "connections";
}

export interface ParsedNote {
  path: string; // repo-relative, e.g. knowledge/git-agent-trust.md
  slug: string; // basename without .md
  slugKey: string; // normalized
  frontmatter: Frontmatter;
  title: string; // H1 text
  /** Section name → raw markdown body (without heading line). */
  sections: Record<string, string>;
  links: WikiLink[];
  /** Raw file content. */
  raw: string;
}

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export type AutomaticMutationType =
  | "CREATE"
  | "ENRICH"
  | "LINK"
  | "ADD_ALIAS"
  | "ADDITIVE_EVOLVE";

export type ProposalMutationType =
  | "ARCHIVE"
  | "RECONCILE_EVOLUTION"
  | "MERGE"
  | "DELETE"
  | "RENAME_SLUG";

export type MutationType = AutomaticMutationType | ProposalMutationType;

export const AUTOMATIC_MUTATION_TYPES: readonly AutomaticMutationType[] = [
  "CREATE",
  "ENRICH",
  "LINK",
  "ADD_ALIAS",
  "ADDITIVE_EVOLVE",
];

export type TargetPrecondition =
  | { kind: "present"; noteId: string; path: string; blobHash: string }
  | { kind: "absent"; slug: string };

/**
 * A fully materialized file write. The executor writes `content` verbatim
 * (or deletes when content is null). The executor never calls a model.
 */
export interface FileWrite {
  path: string;
  content: string | null;
}

export interface Mutation {
  mutationId: string; // "mut_" + ULID
  type: MutationType;
  /** Human-readable commit subject, e.g. "enrich agent autonomy". */
  summary: string;
  /** Declared write set + preconditions. */
  targets: TargetPrecondition[];
  /** Materialized post-state per path. Paths must map 1:1 onto targets. */
  writes: FileWrite[];
  /** Explicit dependencies declared by the planner (mutation ids). */
  dependsOn: string[];
  /** Set when this mutation replaces one that went to REPLAN. */
  replans?: string;
  /** Source references for provenance/audit. */
  evidence: string[];
  reasoning?: string;
}

export type MutationState =
  | "QUEUED"
  | "RUNNING"
  | "COMMITTED"
  | "INTEGRATED"
  | "NOOP"
  | "REPLAN"
  | "BLOCKED"
  | "FAILED_INVALID_EXECUTION"
  | "FAILED";

export interface QueueRow {
  mutationId: string;
  state: MutationState;
  type: MutationType;
  targets: TargetPrecondition[];
  dependsOn: string[];
  replans?: string;
  attemptCount: number;
  lastError?: string;
  /** Informational only; never identity. */
  commitSha?: string;
  createdAt: string;
  updatedAt: string;
  /** Sequence number = logical order on the agent branch. */
  seq: number;
}

export interface ExecutionResult {
  mutationId: string;
  state: MutationState;
  commitSha?: string;
  error?: string;
  /** Set when an automatic mutation was refused because a target is superseded/archived. */
  proposalRequired?: boolean;
}

export interface CommitTrailers {
  mutationId?: string;
  mutationType?: MutationType;
  actor: "agent" | "human-sync" | "human";
  replans?: string;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export type ProposalStatus = "PENDING" | "ACCEPTED" | "REJECTED" | "STALE";

export interface ProposalTargetSnapshot {
  noteId: string;
  path: string;
  blobHash: string;
}

export interface Proposal {
  proposalId: string;
  mutationId: string;
  operation: ProposalMutationType | "RECONCILE_EVOLUTION";
  targets: ProposalTargetSnapshot[];
  /** Materialized writes if accepted. */
  writes: FileWrite[];
  evidence: string[];
  reasoning: string;
  createdAt: string;
  status: ProposalStatus;
  resolvedAt?: string;
  decisionNote?: string;
}

// ---------------------------------------------------------------------------
// Extraction / grounding
// ---------------------------------------------------------------------------

export type TurnRole = "user" | "assistant";

export interface ConversationTurn {
  sessionId: string;
  turnId: string;
  role: TurnRole;
  text: string;
}

export interface Inference {
  text: string;
  /** Source URIs this inference was based on. */
  basedOn: string[];
}

export interface ExtractionCandidate {
  kind: NoteType;
  claim: string;
  /** Source URIs claimed as grounding. */
  groundedSources: string[];
  inferences: Inference[];
  /**
   * For a promoted inference: lineage fields. Present only when the claim
   * originated as an assistant inference that a user turn confirmed.
   */
  lineage?: {
    originatedAs: string; // agent-inference://conversation/<s>/<t>
    groundedIn: string[]; // conversation://<s>/<t> (user turns)
    confirmedBy: string; // conversation://<s>/<t> (user turn)
  };
}

export interface GroundingConfig {
  lowContentMaxTokens: number;
  confirmationLexicon: string[];
}

export interface GroundingVerdict {
  ok: boolean;
  issues: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Repo config and paths
// ---------------------------------------------------------------------------

export interface BrainConfig {
  version: number;
  repoId: string;
  links: { relationships: string[] };
  sync: { quiescenceMs: number };
  grounding: GroundingConfig;
}

export interface RepoPaths {
  /** User worktree root (the knowledge repo checkout). */
  userWorktree: string;
  /** $BRAIN_HOME/repos/<repo_id> */
  stateDir: string;
  agentWorktree: string;
  indexDb: string;
  usageDb: string;
  proposalsDb: string;
  queueDb: string;
  conversationsDir: string;
  runtimeDir: string;
}

export const AGENT_BRANCH = "agent/repo";
export const MAIN_BRANCH = "main";

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export interface Clock {
  now(): number; // ms since epoch
}

export interface SyncResult {
  committed: boolean;
  sha?: string;
  reason?: "clean" | "not-quiescent" | "committed";
}

export interface IntegrationResult {
  status: "integrated" | "refused-dirty" | "nothing-to-integrate" | "rebuilt-and-integrated";
  integratedMutationIds: string[];
  mainSha: string;
}

export interface RebuildResult {
  newAgentHead: string;
  replayed: string[];
  replanned: string[];
  failed: string[];
}

/**
 * Single entry point per knowledge repo. Fixtures drive the engine through
 * this interface; implementations live in src/core/coordinator.ts.
 */
export interface RepoCoordinator {
  readonly paths: RepoPaths;
  readonly config: BrainConfig;

  /** Enqueue and execute an automatic mutation (spec §12), then attempt integration (§15). */
  submit(mutation: Mutation): Promise<ExecutionResult>;

  /** Execute a queued mutation without integrating (used by fixtures). */
  execute(mutationId: string): Promise<ExecutionResult>;

  /** Human Sync primitive (§16). */
  syncOnce(now?: number): Promise<SyncResult>;

  /** Integration (§15). */
  integrate(): Promise<IntegrationResult>;

  /** Rebuild agent branch onto current main (§13). */
  rebuild(): Promise<RebuildResult>;

  /** Startup recovery (§17). */
  recover(): Promise<void>;

  /** Queue inspection. */
  getMutation(mutationId: string): Promise<QueueRow | undefined>;
  listMutations(): Promise<QueueRow[]>;
  enqueue(mutation: Mutation): Promise<void>;

  /** Current heads. */
  mainHead(): Promise<string>;
  agentHead(): Promise<string>;

  /** Index projection of agent HEAD (§41–43). Enqueues ADD_ALIAS on human renames (§21). */
  reconcileIndex(): Promise<ReconcileResult>;

  /** Proposals (§33–34). listProposals refreshes staleness against agent HEAD first. */
  submitProposal(proposal: Proposal): Promise<void>;
  listProposals(): Promise<Proposal[]>;
  acceptProposal(proposalId: string): Promise<ExecutionResult>;
  rejectProposal(proposalId: string, decisionNote?: string): Promise<void>;
  /** Rejected proposals touching any of the given notes (negative evidence, I-20). */
  negativeEvidenceFor(noteIds: string[]): Promise<Proposal[]>;

  close(): Promise<void>;
}

export interface ReconcileResult {
  indexedCommit: string;
  changedPaths: string[];
  /** Human renames detected (same id, new path). An ADD_ALIAS mutation is enqueued for each. */
  renames: { noteId: string; oldPath: string; newPath: string; oldSlug: string }[];
  fullRebuild: boolean;
}

/**
 * Factory. Implemented in src/core/coordinator.ts:
 *   export async function openCoordinator(userWorktree: string, opts?: { clock?: Clock }): Promise<RepoCoordinator>
 * Queue table: queue.sqlite `mutations(mutation_id TEXT PK, state TEXT, ...)` (§11, §52).
 */
export type OpenCoordinator = (userWorktree: string, opts?: { clock?: Clock }) => Promise<RepoCoordinator>;

// ---------------------------------------------------------------------------
// Model / embedding providers (Phases 7–11)
// ---------------------------------------------------------------------------

export interface ModelCompleteInput {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
}

export interface ModelProvider {
  /** Returns raw text; callers parse/validate. */
  complete(input: ModelCompleteInput): Promise<string>;
  /**
   * Optional streaming variant: calls `onDelta` with each text chunk as it
   * arrives and resolves with the full text (identical to what `complete`
   * would return). Providers without native streaming may omit it; callers
   * fall back to `complete`.
   */
  stream?(input: ModelCompleteInput, onDelta: (text: string) => void): Promise<string>;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}
