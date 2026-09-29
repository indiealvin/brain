# v0 Invariants (frozen)

These are the behavioral contracts every implementation phase must preserve.
Each has at least one deterministic fixture in `test/fixtures/`. Fixture files
and `src/core/types.ts` are the goalposts: implementers do not edit them.

## Top-level correctness properties

1. **No stale mutation.** No mutation may modify a note whose blob changed
   since the mutation was planned. Validation is note-level and
   content-addressed (blob hash), never textual Git conflict detection.
2. **Authorship isolation.** An agent commit never contains human filesystem
   changes. A human commit never absorbs agent mutation output.
3. **No automatic belief strengthening.** No automatic path may strengthen,
   replace, resurrect, or reinterpret a user's belief beyond the grounding and
   permission model.
4. **Stable mutation identity.** Mutation identity and dependencies survive
   rebases and branch rewrites. Commit SHA is never mutation identity.
5. **Graceful degradation.** With all derived state deleted, accepted knowledge
   remains coherent as Markdown + Git.

## Mechanism invariants

- **I-1 Optimistic transaction.** Every mutation records write-set
  preconditions at plan time: `PRESENT(note_id, path, blob_hash)` or
  `ABSENT(slug)`. Read-set invalidation is an explicit v0 non-goal.
- **I-2 Sequential validation.** Agent branch rebuild replays pending
  mutations in order; each is validated against `new_main` plus all
  previously replayed valid mutations, never against `new_main` alone.
- **I-3 Declared write set.** After execution every touched path must be in
  the declared target set. Extra paths → `FAILED_INVALID_EXECUTION`, no
  commit, targets never auto-extended. A declared path left byte-identical is
  tolerated. Empty diff → `NOOP`, no commit, not a failure.
- **I-4 Model-free executor.** Planner output is a fully materialized content
  patch. The executor never calls a model. Re-execution is deterministic.
- **I-5 Dependency closure.** B depends on A if the planner declares it, or
  A precedes B and they share a target note, or B's content links to a slug
  that is ABSENT on main and created by A. Closure is transitive.
- **I-6 REPLAN is terminal.** A mutation entering REPLAN never replays its
  patch. Replanning creates a new mutation with `replans: <old id>`.
- **I-7 Replay only RUNNING.** Crash recovery replays a `RUNNING` item only
  after checking the current agent branch for its `Mutation-ID` trailer; if
  present, mark `COMMITTED` instead.
- **I-8 Head-of-line.** An invalid mutation never blocks independent later
  mutations: rebuild parks the invalid closure and integrates the rest.
- **I-9 Clean rebase only.** Cherry-picking a validated mutation must not
  conflict. A conflict is an implementation bug: abort, mark FAILED, never
  resolve ours/theirs.
- **I-10 Integration in the user worktree.** `git merge --ff-only agent/repo`
  runs in the user worktree. Git's own overwrite check protects dirty paths.
  A refusal means retry after the next Human Sync; it is not invalidation and
  causes no state change. Never stash, reset, or overwrite there.
- **I-11 One lock.** Human Sync and integration share one file-based
  `RepoWorktreeLock`. The second observes the first's completed state.
- **I-12 Agent worktree is disposable.** On startup a dirty agent worktree is
  `reset --hard` to the agent branch head. Never stash.
- **I-13 Human Sync commits only quiescent human edits**, authored
  `Actor: human-sync`, never inside an agent commit, never mixing.
- **I-14 Status transitions.** Only `active → tentative` is automatic. All
  other transitions, and any type change, require RECONCILE_EVOLUTION.
- **I-15 Automatic targets.** Automatic ENRICH / ADDITIVE_EVOLVE / structural
  change may target only `active` or `tentative` notes.
- **I-16 Grounding.** Grounded sources are user turns or external documents.
  Assistant turns never ground. A low-content user turn (deterministic rule:
  ≤ `lowContentMaxTokens` tokens, or matches the confirmation lexicon) cannot
  introduce a claim; it may only confirm the immediately preceding inference.
  Promoted inferences keep `Originated-as`, `Grounded-in`, `Confirmed-by`.
  ADDITIVE_EVOLVE content must be grounded.
- **I-17 Validators, not prompts.** Extractor and planner output is untrusted
  until deterministic validators pass it.
- **I-18 Provenance in Markdown.** Provenance needed to interpret epistemic
  status must survive deletion of `$BRAIN_HOME`.
- **I-19 Proposal staleness is content-addressed.** A proposal snapshots
  `{note_id, blob_hash}` for every target; any change → `STALE`. Accepted
  proposals re-enter as mutations whose preconditions are those snapshots.
- **I-20 Rejections persist.** Rejected proposals stay in the store and are
  supplied to the planner as negative evidence.
- **I-21 Namespace.** Slugs and aliases share one case-insensitive namespace;
  slug wins on resolution; colliding alias is rejected; a title change appends
  the old title as alias, and fails if that alias would collide. Slug rename
  is never automatic. A human rename (same `id`, new path) enqueues an
  automatic ADD_ALIAS of the old slug.
- **I-22 Dangling links.** Unresolved links are stored, never auto-created.
- **I-23 Single index.** Exactly one index, projecting `agent/repo` HEAD,
  storing `indexed_commit`; reconcile by tree diff on any movement; full
  rebuild is the fallback when the old commit is unreachable. Incremental
  reconcile must re-resolve links whose target slug or alias was added or
  removed in the change.
- **I-24 Derived data never in Markdown.** Embeddings, backlinks, usage.
- **I-25 BRAIN_HOME.** All application state resolves through `BRAIN_HOME`
  (default `~/.brain`). Tests set it to a temp dir. No code path touches
  `~/.brain` directly.
