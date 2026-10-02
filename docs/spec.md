# v0 Implementation Spec

Status: Ready for implementation
Version: v0
Date: 2026-09-29

Derived from `design.md`. All review amendments are folded into the relevant
section. `invariants.md` is the checklist; this document is the mechanism.

Stack: TypeScript on Bun ≥ 1.4, `bun:sqlite` (FTS5 available), `bun test`,
Git via subprocess (`git -C <path> …`, never `cd`). No ORM, no vector library
in v0 (brute-force cosine over stored Float32 blobs).

This repository (`/home/alvin/Project/brain`) is the **application code**. It
is not a knowledge repo instance. Knowledge repos used by tests are created in
temp directories, and `BRAIN_HOME` is always set to a temp directory in tests.

---

## 1. Purpose and central abstraction

Every knowledge mutation is an **optimistic transaction over explicit
note-level write preconditions**. A mutation:

1. is planned against a specific knowledge state (agent branch HEAD);
2. records **write-set** preconditions (read-set invalidation is a v0
   non-goal);
3. executes deterministically in the agent worktree, with no model call;
4. verifies its actual write set equals the declared target set;
5. commits to the agent branch with a `Mutation-ID` trailer;
6. may later be cherry-picked onto a newer human-authored base;
7. is invalidated and replanned (as a new mutation) if preconditions fail.

Git is the durable mutation log. Markdown is canonical knowledge.

## 2. Top-level correctness properties

See `invariants.md` §"Top-level correctness properties" (5 items).

## 3. Behavioral contract suite

Deterministic. No model calls. Planner/extractor outputs are hand-built
`Mutation` / `ExtractionCandidate` objects. Fixtures live in `test/fixtures/`
and are numbered to match this section.

| # | Fixture | Governing sections |
|---|---|---|
| 3.1 | human commit, clean replay, ff-only succeeds, `main = A+H1+M1'+M2'`, IDs unchanged | 13, 15 |
| 3.2 | blob changed in non-overlapping hunk → M1 REPLAN, never replays | 8, 13 |
| 3.3 | sequential validation: M0 expects X@A→B, M1 expects X@B; unrelated H1; both replay | 13 |
| 3.4 | shared-note implicit dependency: M1(Y), M2(Z), M3(Y); M1 invalid → M3 REPLAN, M2 survives | 10, 13, 14 |
| 3.5 | CREATE with ABSENT(slug); human creates slug first → REPLAN, no duplicate | 8, 13 |
| 3.6 | ENRICH target deleted by human → REPLAN | 8, 13 |
| 3.7 | executor touches undeclared path → FAILED_INVALID_EXECUTION, no commit, targets unchanged | 12 |
| 3.8 | empty diff → NOOP, no commit, not a failure | 12, 53 |
| 3.9 | crash after commit with RUNNING state → COMMITTED, not re-executed | 17 |
| 3.10 | REPLAN item on restart → never replays; a new mutation is planned | 11, 17 |
| 3.11 | human dirty X in user worktree; agent commit of Y excludes X; agent targeting X → ff refused, no overwrite, no state change | 15, 16 |
| 3.12 | RepoWorktreeLock serializes Human Sync and integration | 15, 16 |
| 3.13 | superseded/archived target → PROPOSAL_REQUIRED, no automatic mutation | 20, 30 |
| 3.14 | MERGE proposal with A@h1,B@h2; B changes → STALE | 33 |
| 3.15 | alias colliding with slug or alias (case-insensitive) rejected | 22 |
| 3.16 | title change appends old title to aliases; collision fails the change | 22 |
| 3.17 | low-content sole grounding rejected; may confirm preceding inference | 28, 38 |
| 3.18 | ADDITIVE_EVOLVE sourced only from assistant turn rejected | 31, 38 |
| 3.19 | rejected proposal appears in planner context as negative evidence | 34, 39 |
| 3.20 | link-target implicit dependency: CREATE A, LINK B→A; CREATE invalid → LINK REPLAN | 10 |
| 3.21 | incremental index re-resolves links when target slug/alias appears or disappears | 43 |
| 3.22 | human rename (same id, new path) → automatic ADD_ALIAS of old slug enqueued | 21, 43 |
| 3.23 | accepted proposal re-enters as mutation with snapshot preconditions; stale at execution → STALE, not executed | 34 |
| 3.24 | precondition path mismatch (note moved) → REPLAN | 8, 9 |

## 4. State domains

1. **Knowledge repository** (user-owned Git repo): `brain.toml`, `knowledge/`,
   `projects/`, `attachments/`, `AGENTS.md`.
2. **User worktree**: the normal checkout on `main`.
3. **Agent worktree**: `$BRAIN_HOME/repos/<repo_id>/worktrees/agent`, branch
   `agent/repo`. Never edited by humans.
4. **Proposal store**: `$BRAIN_HOME/repos/<repo_id>/proposals.sqlite`.
5. **Conversation store**: `$BRAIN_HOME/repos/<repo_id>/conversations/`.

## 5. Repository configuration — `brain.toml`

```toml
version = 1
repo_id = "01KABCDEF..."

[links]
relationships = ["related", "supports", "contradicts", "extends", "example-of"]

[sync]
quiescence_ms = 1500

[grounding]
low_content_max_tokens = 4
confirmation_lexicon = ["yes", "yeah", "yep", "exactly", "right", "correct", "agreed", "i agree", "that's it", "that's what i mean"]
```

`repo_id` is generated once by `brain init`, committed, stable across clones,
and never regenerated because a repo moved.

## 6. Application state layout

```
$BRAIN_HOME/repos/<repo_id>/
├── index.sqlite
├── usage.sqlite
├── proposals.sqlite
├── queue.sqlite
├── conversations/
├── worktrees/agent/
└── runtime/            locks, pid files
```

`BRAIN_HOME` env var overrides `~/.brain`. Every path is resolved through
`resolveBrainHome()`; nothing reads `~/.brain` directly.

## 7. Mutation model

### 7.1 Identity

`mutation_id = "mut_" + ULID`. Commit trailers:

```
Mutation-ID: mut_01K...
Mutation-Type: ENRICH
Actor: agent
Replans: mut_01J...        (optional)
```

Mutation ID survives rebase, cherry-pick, branch rebuild, SHA change.

### 7.2 Types

Automatic: `CREATE ENRICH LINK ADD_ALIAS ADDITIVE_EVOLVE`.
Proposal-only: `ARCHIVE RECONCILE_EVOLUTION MERGE DELETE RENAME_SLUG`.
No MOVE.

## 8. Preconditions

```
TargetPrecondition =
  | { kind: "present", noteId, path, blobHash }
  | { kind: "absent", slug }
```

A mutation is valid iff every precondition matches the tree it is validated
against exactly: for `present`, `git rev-parse <tree>:<path>` succeeds and
equals `blobHash` (a moved file fails this and goes to REPLAN); for `absent`,
no file with that slug (case-insensitive basename) exists in the tree.
Validation reads Git trees, never the user worktree filesystem.

## 9. Target set

`targets: TargetPrecondition[]` is also the declared write set. Multi-note
operations declare every note they touch. CREATE declares `absent(slug)` and
its write set is the new path.

## 10. Dependency rules

B depends on A if any holds:

1. **Explicit**: planner declares `dependsOn: [A]`.
2. **Shared target**: A precedes B in agent history and
   `targetNotes(A) ∩ targetNotes(B) ≠ ∅` (by note_id, or by slug for
   CREATE).
3. **Link target**: B's materialized content contains `[[slug]]` where slug is
   ABSENT on the base the pending mutations were planned against
   (`merge-base(oldAgentHead, newMain)`, not the new main) and A is a pending
   CREATE of that slug.

Rules 2 and 3 are computed deterministically by the coordinator; the planner
cannot opt out. Closure is transitive.

## 11. Mutation state machine

```
QUEUED → RUNNING → COMMITTED → INTEGRATED
                 ↘ NOOP
                 ↘ FAILED_INVALID_EXECUTION
                 ↘ FAILED
QUEUED|COMMITTED → REPLAN            (terminal; a new mutation is created)
QUEUED|COMMITTED → BLOCKED → REPLAN  (dependency closure)
```

- `NOOP`: terminal success, no commit.
- `REPLAN`: terminal. Replanning yields a **new** mutation id with
  `replans: <old>`. The old patch is never replayed.
- `BLOCKED`: dependency of an invalid mutation; resolved to REPLAN when the
  rebuild completes.
- `FAILED_INVALID_EXECUTION`: write set ≠ declared targets.
- `FAILED`: cherry-pick conflict (bug) or unexpected error; `lastError` set.

Queue table `queue.sqlite` → `mutations(mutation_id TEXT PRIMARY KEY, seq
INTEGER, state TEXT, type TEXT, summary TEXT, targets_json TEXT, writes_json
TEXT, depends_on_json TEXT, replans TEXT NULL, evidence_json TEXT, reasoning
TEXT NULL, attempt_count INTEGER, last_error TEXT NULL, commit_sha TEXT NULL
(informational only), created_at TEXT, updated_at TEXT)`. Fixture 3.9 forces
`state = 'RUNNING'` directly on this table to simulate a crash.

## 12. Execution algorithm (automatic mutation)

Runs in the agent worktree under the coordinator's single-writer lock. That
lock is cross-process: it is the repo-wide `RepoWorktreeLock` (§15–16,
I-11), taken once per public write operation, so no two `brain` processes
ever execute, integrate, rebuild, sync or recover at the same time.

1. `state = RUNNING`.
2. If the current agent branch already has a commit with this
   `Mutation-ID` → `COMMITTED`, stop.
3. Validate preconditions against agent HEAD tree. Fail → `REPLAN`.
4. If any `present` target has `status ∉ {active, tentative}` (I-15) and the
   operation is automatic → no commit; `state = REPLAN`,
   `lastError = "PROPOSAL_REQUIRED"`, `ExecutionResult.proposalRequired = true`.
   (The planner is expected to re-emit it as a proposal.)
5. Ensure agent worktree is clean (`git status --porcelain` empty); if not,
   `reset --hard agent/repo`.
6. Apply the materialized patch (write full file contents per target; the
   plan carries complete post-state per file, not instructions).
7. `git status --porcelain` in the agent worktree → touched paths.
8. Empty → `NOOP`, stop.
9. Map touched paths to notes. Every touched path must be in the declared
   write set; a touched path outside it → `reset --hard`,
   `FAILED_INVALID_EXECUTION`, stop. A declared path that turned out
   byte-identical is tolerated (partial NOOP). Never extend targets.
10. Normalize: if a `present` target's title changed, append the old title to
    `aliases` (§22). Run Markdown validators (frontmatter, namespace incl.
    alias collision, link grammar, content class rules). Fail →
    `reset --hard`, `FAILED` with `lastError` naming the issue code.
11. `git add -A && git commit` with trailers.
12. `state = COMMITTED`.
13. Reconcile index to new agent HEAD (§41).
14. Attempt integration (§15).

## 13. Agent branch rebuild

Inputs: `newMain` (sha), ordered pending mutations (COMMITTED, not yet
INTEGRATED), dependency graph (§10).

```
rebuildTree = newMain
git -C agentWt checkout -B agent/repo newMain
invalid = {}
for m in pending (in agent-branch order):
  if m ∈ closure(invalid): park(m, BLOCKED→REPLAN); continue
  if !validate(m.targets, rebuildTree): invalid += m; m → REPLAN; continue
  git -C agentWt cherry-pick <m.oldSha>   # trailers preserved
  if conflict: cherry-pick --abort; m → FAILED (bug); invalid += m; continue
  verify write set of new commit == m.targets  (else FAILED)
  rebuildTree = HEAD
```

Old SHAs are located by `git log <oldAgentHead> --grep "Mutation-ID: <id>"
--fixed-strings`. After rebuild, queue rows update `commit_sha`.

## 14. Head-of-line blocking

The loop above parks only the invalid closure; independent later mutations
are cherry-picked and can integrate. Fixture 3.4 and 3.20.

## 15. Integration (user worktree)

Under `RepoWorktreeLock`:

1. Run `HumanSync.syncOnce()` (commits quiescent human edits, §16).
2. If `main` moved since agent branch base → rebuild (§13).
3. `git -C userWt merge --ff-only agent/repo`.
4. On success: mark integrated mutations `INTEGRATED`.
5. On refusal because a dirty path would be overwritten: **no state change**;
   release the lock; retry after the next Human Sync quiescence. Never
   stash, reset, checkout, or overwrite in the user worktree.
6. Reconcile index (agent HEAD unchanged after ff, so usually a no-op).

## 16. Human Sync

- Primitive: `syncOnce(now)` — if the user worktree has dirty paths and the
  last filesystem change is older than `quiescence_ms`, `git add -A` (respecting
  `.gitignore`) and commit with message `user: <summary>` and trailer
  `Actor: human-sync`. Returns the new sha or null.
- The filesystem watcher is a thin shell that records last-change time and
  calls `syncOnce` on a timer. Tests call `syncOnce` with an injected clock.
- Runs only under `RepoWorktreeLock`.
- Never touches the agent worktree; never commits inside an agent commit.
- Manual `git commit` by the user is accepted as ordinary history.
- Default `.gitignore` written by `brain init` excludes `.obsidian/workspace*`
  and `.brain/`.

## 17. Crash recovery (startup and every drain)

Runs at startup and again at the start of every drain of the queue, inside
the same lock section as the drain. While the lock is held, no other
process can be executing, so any `RUNNING` row seen is from a crashed
holder.

1. Agent worktree dirty → `git reset --hard agent/repo`. Never stash.
2. For each queue row `RUNNING`: if the current `agent/repo` has a commit with
   its `Mutation-ID` → `COMMITTED`; else re-execute from §12 (deterministic).
3. `REPLAN` rows are never replayed; they are terminal. The planner will have
   been asked (or will be asked) for a new mutation with `replans`.
4. `BLOCKED` rows are resolved to `REPLAN`.
5. Reconcile index to agent HEAD.
6. Accepted proposals are reconciled with the queue by their `mutationId`.
   An ACCEPTED proposal with no queue row gets the same mutation rebuilt
   from the proposal, then enqueued, executed and integrated. An ACCEPTED
   proposal whose row is `REPLAN` is marked `STALE` (§34).

## 18. Markdown identity model

Frontmatter (YAML, minimal subset):

```yaml
---
id: 01K...
created: 2026-09-28
type: idea
status: active
aliases: []          # may be omitted when empty
---
```

Required: `id`, `created`, `type`, `status`. The H1 is the title. Unknown
frontmatter keys written by humans are preserved verbatim (`Frontmatter.extra`)
and re-emitted by `serializeNote` after the known keys, so agent rewrites never
drop them.

## 19. Note types

`idea decision hypothesis question observation reference`. Changing type after
CREATE requires RECONCILE_EVOLUTION.

## 20. Note status

`active tentative superseded resolved archived`. Automatic transition:
`active → tentative` only. Everything else via RECONCILE_EVOLUTION.

## 21. Slugs

Filename basename without `.md`. Repo-wide unique, compared by `slugKey`
(NFKC→NFD, combining marks stripped, lowercased, whitespace collapsed), so
`Café` and `cafe` collide by design. Never changed automatically. `RENAME_SLUG`
requires explicit approval and rewrites every inbound link and adds the old
slug as alias.

**Human rename.** When the indexer sees a note whose `id` is unchanged but
path differs from the previous index state, the coordinator enqueues an
automatic `ADD_ALIAS(old slug)` for that note.

### 21.1 Module exports used by fixtures

- `src/markdown/parse.ts`: `parseNote(path: string, raw: string): ParsedNote`
  (throws `NoteParseError` on missing/invalid frontmatter).
- `src/markdown/validate.ts`: `slugKey(s): string`,
  `validateNote(note): ValidationIssue[]`,
  `checkAliasCollision(alias, namespace: Map<string, string /*noteId*/>, selfNoteId): ValidationIssue | null`,
  `isLowContentTurn(text, config: GroundingConfig): boolean`.
- `src/extract/groundingValidator.ts`:
  `validateGroundingSources(sources: string[], turns: ConversationTurn[], config): GroundingVerdict`,
  `validateCandidate(candidate, turns, config): GroundingVerdict`.
  Issue codes: `ASSISTANT_GROUNDING`, `LOW_CONTENT_SOLE_GROUNDING`,
  `MISSING_LINEAGE`, `MALFORMED_SOURCE`, `UNKNOWN_TURN`, `CONFIRMATION_NOT_ADJACENT`.
- `src/markdown/serialize.ts`: `serializeNote(note: ParsedNote): string` (stable round-trip).
- `src/sync/lock.ts`: `withRepoWorktreeLock<T>(runtimeDir: string, fn: () => Promise<T>): Promise<T>`.
- `src/index/reconcile.ts`: `rebuildIndex(paths: RepoPaths, commit: string): Promise<void>` (full rebuild, §42).
- `src/core/coordinator.ts`: `openCoordinator(userWorktree, opts?)` (see `types.ts`).

## 22. Alias namespace

Slugs and aliases share one case-insensitive namespace. Resolution: exact slug,
then exact alias; slug wins. An `ADD_ALIAS` colliding with any slug or alias is
rejected by the validator. On title change the old title is appended to
`aliases` unless present; if it would collide, the title-change mutation fails
validation.

## 23. Link grammar

- Bare `[[target]]` or `[[target|Display]]` in body → `related`.
- Under `## Connections`: `- <relationship> [[target|Display?]]`.
- `target` is a slug or an alias (humans may write either). Agent-generated
  links use slugs only.
- Unknown relationship strings are parsed and stored; the v0 agent emits only
  the configured vocabulary.

## 24. Dangling links

Stored with `resolved = 0`. Never auto-create a note for a dangling link.

## 25. Backlinks

Derived from `links`; never stored in Markdown.

## 26. Content classes

Grounded / Inferred / Structural as in `design.md` §11. In Markdown:

- Grounded content sits under `## Claim`, `## Evidence`, `## Evolution` with
  `Grounded-in:` / `Source:` lines.
- Inferred content sits under `## Agent inference` with `Inferred-from:`.
- Promoted inference carries `Originated-as:`, `Grounded-in:`, `Confirmed-by:`.

## 27. Grounding sources

`conversation://<session-id>/<turn-id>` (user turn only),
`document://<document-id>#<fragment>`, `agent-inference://conversation/<s>/<t>`
(lineage only, never grounding).

## 28. Low-content confirmation (deterministic rule)

A user turn is low-content if, after trimming and lowercasing, it has
≤ `low_content_max_tokens` whitespace tokens **or** it matches an entry of
`confirmation_lexicon` exactly (punctuation stripped). Such a turn cannot be
the sole grounding of a claim; it may appear as `Confirmed-by` for an
inference whose `Originated-as` is the immediately preceding assistant turn.

## 29. Provenance in Markdown

Required for interpretation; must survive deletion of `$BRAIN_HOME`.

## 30. ENRICH rules

May: add grounded material, clarify without changing meaning, add links, add
aliases. Must not: promote inference, strengthen the claim, touch superseded
or archived notes, change type/status except `active → tentative`.

## 31. ADDITIVE_EVOLVE

Automatic iff content is grounded, target is active/tentative, operation is
additive (appends a dated entry under `## Evolution`), core claim untouched.
May set `status: tentative`.

## 32. RECONCILE_EVOLUTION

Always a proposal.

## 33. Proposal model

```
Proposal { proposalId, mutationId, operation, targets: {noteId, path, blobHash}[],
           proposedDiff, evidence, reasoning, createdAt, status, resolvedAt?, decisionNote? }
```

Any target blob change → `STALE`.

## 34. Proposal lifecycle

`PENDING → ACCEPTED | REJECTED | STALE`. Rejected proposals persist and are
supplied to the planner as negative evidence. **ACCEPTED** enqueues a mutation
whose preconditions are the target snapshots. If validation fails at execution,
or the accepted mutation is later invalidated at rebuild (§13), the proposal is
marked `STALE`. Decisions are compare-and-set on the current status: an
accept and a reject of the same proposal can never both take effect.

## 35. Proposal inbox

Persistent UI surface; deferred to Phase 11 UI, but the store and API exist
from Phase 10.

## 36. Conversation pipeline

`turn → Extractor → GroundingValidator → candidates → Retriever → Planner →
MutationValidator → automatic mutation | proposal`.

## 37. Extractor output

```
{ candidates: [{ kind, claim, groundedSources: string[], inferences: [{ text, basedOn: string[] }] }] }
```

Untrusted until validated.

## 38. Grounding validator (deterministic)

Rejects: assistant-only grounding; low-content sole grounding; promoted
inference without lineage; automatic evolution sourced only from inference;
malformed source URIs; grounding URIs that do not point at user turns.

## 39. Planner interface

Input: candidate, relevant notes (full content + blob hashes), graph
neighbors, pending mutations, pending proposals, rejected proposals, config.
Output: `Mutation` objects with fully materialized per-file post-state, or
`Proposal` objects. The executor never calls a model (I-4).

## 40. Planner read view

Exactly one indexed state: `agent/repo` HEAD. Pending proposals are supplied
separately.

## 41. Index projection

One `index.sqlite` projecting `agent/repo` HEAD. `index_meta.indexed_commit`.
On any movement: if `indexed_commit != agentHead` → reconcile.

## 42. History rewrite reconciliation

`git diff --name-status <indexed_commit> <agentHead>` works as long as the old
object exists (reflog retention). If it does not → full rebuild.

## 43. Incremental indexing

For each changed path: parse, upsert `notes`, `aliases`, `links`, FTS row,
embedding if `retrieval_content_hash` changed. Deleted paths remove rows.
**Then** collect the set of slugs and aliases added or removed in this batch
and re-resolve every `links` row whose `target_key` matches, updating
`target_note_id` and `resolved`. Detect human renames (§21).

## 44–48. Retrieval

Hybrid: FTS5 (lexical) + cosine over stored embeddings (semantic) + graph
neighbors (1–2 hops from top candidates). Union, rerank by weighted sum with
simple v0 weights. Embedding input: title + claim + grounded content; no
derived keywords in v0. `EmbeddingProvider` interface with a deterministic
hashing provider for tests and a Claude/Voyage adapter for real use.

## 49. Index schema

```sql
index_meta(repo_id TEXT, indexed_commit TEXT, schema_version INTEGER);
notes(note_id TEXT PK, slug TEXT, slug_key TEXT UNIQUE, path TEXT UNIQUE, title TEXT,
      type TEXT, status TEXT, created_at TEXT, blob_hash TEXT, retrieval_content_hash TEXT);
aliases(alias TEXT, alias_key TEXT UNIQUE, note_id TEXT);
links(source_note_id TEXT, target_key TEXT, target_note_id TEXT NULL,
      relationship TEXT, resolved INTEGER, section TEXT);
notes_fts(note_id UNINDEXED, title, body)  -- FTS5
embeddings(note_id TEXT, model TEXT, retrieval_content_hash TEXT, dims INTEGER, vector BLOB);
```

`*_key` columns are the case-insensitive normalized form.

## 50. Usage state

`usage.sqlite`: `last_accessed, access_count, search_clicks`. Loss acceptable.

## 51. Proposal store

`proposals.sqlite` with the §33 fields; `targets_json`, `evidence_json`.

## 52. Queue

`queue.sqlite` with §11 rows. Holds orchestration state only; pending
knowledge state is the agent branch.

## 53. NOOP

No commit, not an error, excluded from revert and failure rates, tracked as
`noop_rate`.

## 54. Commit format

```
knowledge: enrich agent autonomy

Mutation-ID: mut_01K...
Mutation-Type: ENRICH
Actor: agent
```

```
user: update agent autonomy

Actor: human-sync
```

## 55–59. Metrics and evals

As in `design.md` §20. Contract tests are `bun test`; model evals live under
`evals/` and are never part of the default test run.

## 60. Implementation order

See `todo.md`. Phases 1–7 are deterministic and must be fully green. Phases
8–11 are built behind a `ModelProvider` interface with mocked-provider contract
tests plus a Claude adapter. Phase 12 is dogfood.

## 61. v0 exit criteria

1. All contract fixtures pass. 2. Human and agent commits cleanly
attributable. 3. Rebuild survives concurrent human edits. 4. Stale mutations
reliably REPLAN. 5. No undeclared write commits. 6. NOOP harmless.
7. Accepted knowledge coherent as Markdown + Git. 8. Index rebuilds from repo.
9. Semantic retrieval finds conceptually related notes. 10. Grounding
validator blocks assistant-authored belief laundering. 11. Proposal decisions
persist and influence planning. 12. One heavy user runs it continuously
without manually reorganizing.
