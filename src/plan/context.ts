/**
 * Planner context builder (spec §39–40, §44–48; I-20, I-23).
 *
 * `buildPlannerInput` assembles everything the planner is allowed to see:
 * the validated candidate, the transcript, the retrieved notes read at
 * `agent/repo` HEAD (full content + blob hash, so preconditions can be
 * snapshotted), 1-hop graph neighbors, pending mutations and proposals, and
 * rejected proposals as negative evidence. The planner reads exactly one
 * indexed state: agent HEAD (§40).
 */
import { AGENT_BRANCH } from "../core/types";
import type {
  BrainConfig,
  ConversationTurn,
  EmbeddingProvider,
  ExtractionCandidate,
  NoteStatus,
  NoteType,
  Proposal,
  QueueRow,
  RepoCoordinator,
} from "../core/types";
import { blobAt, showFile } from "../git/git";
import { neighbors as graphNeighbors } from "../index/backlinks";
import { namespace, noteById } from "../index/queries";
import type { IndexDb } from "../index/schema";
import { NoteParseError, parseNote } from "../markdown/parse";
import { retrieveForPlanner } from "../retrieval/hybrid";

export interface PlannerNote {
  noteId: string;
  path: string;
  slug: string;
  title: string;
  status: NoteStatus;
  type: NoteType;
  /** Blob hash at agent HEAD; becomes the `present` precondition. */
  blobHash: string;
  /** Full file content at agent HEAD. */
  raw: string;
}

export interface PlannerNeighbor {
  noteId: string;
  path: string;
  title: string;
}

export interface PlannerInput {
  candidate: ExtractionCandidate;
  turns: ConversationTurn[];
  /** Retrieved notes, best match first. */
  notes: PlannerNote[];
  /** 1-hop graph neighbors of the top hits that are not themselves retrieved. */
  neighbors: PlannerNeighbor[];
  /** QUEUED / RUNNING / COMMITTED rows (not yet integrated). */
  pendingMutations: QueueRow[];
  pendingProposals: Proposal[];
  /** Rejected proposals touching any retrieved note (I-20). */
  rejectedProposals: Proposal[];
  config: BrainConfig;
  /** YYYY-MM-DD */
  today: string;
  /**
   * Every key of the shared slug/alias namespace at agent HEAD (`slugKey`
   * form). Used for CREATE collision checks and dangling-link detection.
   */
  nsKeys: Set<string>;
}

export interface PlannerContextDeps {
  coord: RepoCoordinator;
  db: IndexDb;
  embeddings: EmbeddingProvider;
  /** YYYY-MM-DD */
  today: string;
}

export interface BuildPlannerInputOptions {
  /** Maximum retrieved notes. Default 10. */
  limit?: number;
  /** Number of top hits used as graph seeds for neighbors. Default 3. */
  neighborSeeds?: number;
}

const PENDING_STATES = new Set<QueueRow["state"]>(["QUEUED", "RUNNING", "COMMITTED"]);

/** Retrieval queries for a candidate: the claim plus each inference text. */
export function candidateQueries(candidate: ExtractionCandidate): string[] {
  const out = [candidate.claim, ...candidate.inferences.map((i) => i.text)];
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

export async function buildPlannerInput(
  deps: PlannerContextDeps,
  candidate: ExtractionCandidate,
  turns: ConversationTurn[],
  opts: BuildPlannerInputOptions = {},
): Promise<PlannerInput> {
  const { coord, db, embeddings, today } = deps;
  const limit = opts.limit ?? 10;
  const seedCount = opts.neighborSeeds ?? 3;
  const wt = coord.paths.agentWorktree;

  const hits = await retrieveForPlanner(db, embeddings, candidateQueries(candidate), limit);

  const notes: PlannerNote[] = [];
  const included = new Set<string>();
  for (const hit of hits) {
    const row = noteById(db, hit.noteId);
    if (!row) continue;
    const raw = showFile(wt, AGENT_BRANCH, row.path);
    const blobHash = blobAt(wt, AGENT_BRANCH, row.path);
    if (raw === null || blobHash === null) continue;
    let parsed;
    try {
      parsed = parseNote(row.path, raw);
    } catch (e) {
      if (e instanceof NoteParseError) continue;
      throw e;
    }
    notes.push({
      noteId: parsed.frontmatter.id,
      path: row.path,
      slug: parsed.slug,
      title: parsed.title,
      status: parsed.frontmatter.status,
      type: parsed.frontmatter.type,
      blobHash,
      raw,
    });
    included.add(parsed.frontmatter.id);
  }

  const neighborsOut: PlannerNeighbor[] = [];
  const seenNeighbor = new Set<string>();
  for (const seed of notes.slice(0, seedCount)) {
    for (const id of graphNeighbors(db, seed.noteId, 1)) {
      if (included.has(id) || seenNeighbor.has(id)) continue;
      const row = noteById(db, id);
      if (!row) continue;
      seenNeighbor.add(id);
      neighborsOut.push({ noteId: id, path: row.path, title: row.title });
    }
  }

  const pendingMutations = (await coord.listMutations()).filter((r) => PENDING_STATES.has(r.state));
  const pendingProposals = (await coord.listProposals()).filter((p) => p.status === "PENDING");
  const rejectedProposals = notes.length > 0 ? await coord.negativeEvidenceFor(notes.map((n) => n.noteId)) : [];

  return {
    candidate,
    turns,
    notes,
    neighbors: neighborsOut,
    pendingMutations,
    pendingProposals,
    rejectedProposals,
    config: coord.config,
    today,
    nsKeys: new Set(namespace(db).keys()),
  };
}
