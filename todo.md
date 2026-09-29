# v0 Implementation TODO

Legend: `[ ]` open · `[~]` in progress (subagent) · `[x]` implemented ·
`[v]` validated by main agent (tests run, diff read, checkpoint committed).

Rules for every task:
- Read `docs/spec.md`, `docs/invariants.md`, `src/core/types.ts` first.
- `test/fixtures/**` and `src/core/types.ts` are read-only for implementers.
  If a fixture looks wrong, report it; do not edit it.
- Never `test.skip`, `.only`, or weaken assertions.
- All app state goes through `BRAIN_HOME`; tests use temp dirs.
- Git via `git -C <path>`; never `cd`.
- Commands: `bun test`, `bunx tsc --noEmit`.

## Phase 0 — Scaffold (main agent)
- [x] P0.1 Docs: `docs/design.md`, `docs/spec.md`, `docs/invariants.md`
- [x] P0.2 `package.json`, `tsconfig.json`, `.gitignore`, `bun test` runs
- [x] P0.3 `src/core/types.ts`: Mutation, TargetPrecondition, MutationState,
      Note, ParsedNote, Proposal, ExtractionCandidate, RepoCoordinator,
      ModelProvider, EmbeddingProvider interfaces
- [x] P0.4 `test/harness/`: `makeTempKnowledgeRepo`, `writeNote`,
      `commitAsHuman`, `blobAt`, `mutationIdsOn`, `withBrainHome`, fake clock
- [x] P0.5 Fixtures 3.1–3.24 written as failing tests against the seam

## Phase 1 — Contract harness green for pure helpers
- [x] P1.1 `src/core/brainHome.ts`: `resolveBrainHome()`, repo state paths
- [x] P1.2 `src/core/ids.ts`: ULID, `mut_` ids; `src/core/slug.ts`: normalize key
- [x] P1.3 `src/git/git.ts`: thin subprocess wrapper (`run`, `revParse`,
      `blobAt(tree, path)`, `treeHasSlug`, `log --grep`, `status --porcelain`,
      trailers parse/format)
- Acceptance: harness compiles; fixtures fail for the right reason (missing impl)

## Phase 2 — Markdown repository
- [x] P2.1 `src/markdown/parse.ts`: frontmatter (id/created/type/status/aliases),
      H1 title, sections, wikilinks (bare + Connections typed grammar §23)
- [x] P2.2 `src/markdown/serialize.ts`: round-trip stable output
- [x] P2.3 `src/markdown/validate.ts`: required fields, enums, namespace
      (case-insensitive slug/alias), title-change→alias rule §22, content-class
      section rules §26, low-content rule §28
- [x] P2.4 `src/markdown/repo.ts`: `brain init` (brain.toml, .gitignore,
      AGENTS.md), load config
- [x] P2.6 preserve unknown frontmatter keys (`Frontmatter.extra`) in parse/serialize
- [x] P2.5 `src/extract/groundingValidator.ts` §38 (pure; uses isLowContentTurn)
- Acceptance: `test/fixtures/markdown.test.ts` and `test/fixtures/grounding.test.ts` fully pass

## Phase 3 — Git mutation engine
- [x] P3.1 `src/git/worktree.ts`: ensure agent worktree + `agent/repo` branch
      under `$BRAIN_HOME/repos/<id>/worktrees/agent`; reset-hard recovery
- [x] P3.2 `src/core/preconditions.ts`: validate PRESENT/ABSENT against a tree §8
- [x] P3.3 `src/core/executor.ts`: §12 algorithm (idempotent by Mutation-ID,
      write set check, NOOP, validators, commit with trailers)
- [x] P3.4 `src/core/queue.ts`: `queue.sqlite` state machine §11
- [x] P3.5 `src/core/coordinator.ts` scaffold: paths/config, queue, execute, submit,
      recover §17 (1–4), minimal ff-only integrate; later-phase methods throw `not implemented`
- Acceptance: `test/fixtures/engine.test.ts` fully passes (3.7, 3.8, 3.9, 3.13, 3.15b, 3.16; 3.24 needs Phase 5 and may stay red until then)

## Phase 4 — Human Sync + lock
- [ ] P4.1 `src/sync/lock.ts`: file-based `RepoWorktreeLock` under `runtime/`
- [ ] P4.2 `src/sync/humanSync.ts`: `syncOnce(now)` with injected clock §16;
      watcher shell (not under test)
- [ ] P4.3 `src/core/integrate.ts`: §15 ff-only in user worktree; refusal =
      retry, no state change
- Acceptance: `test/fixtures/sync.test.ts` fully passes (3.11 needs rebuild → do with Phase 5)

## Phase 5 — Agent branch rebuild
- [ ] P5.1 `src/core/deps.ts`: dependency rules §10 (explicit, shared target,
      link target) + transitive closure
- [ ] P5.2 `src/core/rebuild.ts`: §13 sequential validate + cherry-pick,
      park closure, FAILED on conflict
- [ ] P5.3 `src/core/coordinator.ts`: `RepoCoordinator` wiring execute →
      integrate → rebuild; startup recovery §17
- Acceptance: `test/fixtures/rebuild.test.ts`, `sync.test.ts`, `engine.test.ts` all pass

- [ ] P3.6 executor step 9: tolerate declared-but-untouched paths (spec §12 amended)
- [ ] P3.7 (perf, later) executor namespace check should use the index instead of parsing every note

## Phase 6 — Index
- [ ] P6.1 `src/index/schema.ts` §49; open/migrate `index.sqlite`
- [ ] P6.2 `src/index/reconcile.ts`: commit-addressed incremental §41–43,
      link re-resolution, human-rename detection → ADD_ALIAS enqueue, full
      rebuild fallback
- [ ] P6.3 `src/index/backlinks.ts`
- Acceptance: `test/fixtures/index.test.ts` passes

## Phase 7 — Retrieval
- [ ] P7.1 `src/retrieval/lexical.ts` (FTS5)
- [ ] P7.2 `src/retrieval/semantic.ts` (EmbeddingProvider; hashing provider
      for tests; cosine brute force)
- [ ] P7.3 `src/retrieval/graph.ts`, `src/retrieval/hybrid.ts` rerank
- Acceptance: retrieval unit tests with deterministic provider; lexical
  mismatch case found via graph/semantic

## Phase 8 — Extractor + validators
- [x] P8.1 `src/extract/groundingValidator.ts` §38 (pure) — done in P2.5
- [ ] P8.2 `src/extract/extractor.ts` behind `ModelProvider`; prompt +
      JSON schema; mocked-provider tests
- Acceptance: extractor contract tests with mock provider

## Phase 9 — Planner
- [ ] P9.1 `src/plan/planner.ts` behind `ModelProvider`: produces fully
      materialized `Mutation`s / `Proposal`s §39
- [ ] P9.2 `src/plan/mutationValidator.ts`: permission table, status
      protection, target declaration completeness
- Acceptance: mocked-provider tests; 3.13 end-to-end

## Phase 10 — Proposal lifecycle
- [ ] P10.1 `src/proposal/store.ts` (`proposals.sqlite`) §33–34
- [ ] P10.2 accept → mutation with snapshot preconditions; stale detection
- [ ] P10.3 rejected proposals → planner negative evidence
- Acceptance: `test/fixtures/proposals.test.ts` passes

## Phase 11 — Conversation interface + Claude adapter
- [ ] P11.1 `src/model/claude.ts` `ModelProvider` adapter (load `claude-api`
      skill first)
- [ ] P11.2 `src/cli.ts`: `brain init | chat | index --rebuild | proposals |
      sync`
- [ ] P11.3 conversation store; async knowledge-update events
- Acceptance: `brain chat` runs one turn end-to-end with mock provider

## Phase 12 — Dogfood + evals (not automated here)
- [ ] P12.1 `evals/` golden sets: extraction, mutation, retrieval
- [ ] P12.2 trust metrics from Git trailers (revert, correction, NOOP rate)
