# Brain for Mac — Implementation Plan

Status: Draft, for review
Date: 2026-09-29
Derived from: `docs/mac-app/design.md` (design), `docs/mac-app/protocol.md`
(protocol). Authority is unchanged: `docs/design.md`, `docs/invariants.md`
and `docs/spec.md` win on any conflict, then design and protocol, then this
plan.

This plan orders the work. It adds no behavior beyond the staging decisions
in §2. Whenever a task needs a
test that design or protocol already specifies, the task cites that test
instead of restating it, so there is only one source for each test.

---

## 1. Rules

- **Implementer rules.** Every task follows the "Rules for every task" block
  in `todo.md`. That covers reading `docs/spec.md`, `docs/invariants.md` and
  `src/core/types.ts` first; treating fixtures and `types.ts` as read-only;
  never using `test.skip`; using `BRAIN_HOME` temp dirs; using `git -C`; and
  running `bun test` and `bunx tsc --noEmit`. For Swift tasks, add the
  project's `xcodebuild test`.
- **One task, one commit.** Each task is one reviewable commit, and the
  suite is green at every commit.
- **Gates.**
  - A `Gate:` line names a design §15 sign-off (CR-1, CR-5, CR-7, CR-10) or
    an open decision. The task cannot start until that is resolved.
  - Tasks without a gate may start once their dependencies are done.
- **Owner tasks.** A task whose ID starts with `O` edits a frozen document
  (`docs/design.md`, `docs/invariants.md`, `docs/spec.md`). Only the owner
  performs it, and it lands before the implementer tasks that would
  otherwise contradict the frozen text.
- **Tags.** `[core]` means TypeScript under `src/`. `[rpc]` means
  `src/rpc/` plus `test/rpc/`. `[app]` means Swift under `apps/mac/`.
  `[ci]` means `.github/`.

## 2. Decisions this plan makes, and those it waits for

**Made here** (the owner may override):

- **Swift lives in `apps/mac/` in this repo.** Both sides replay the
  conformance transcripts under `test/rpc/transcripts/` (protocol §9), so
  one CI run checks both against the same files.
- **M0 ships to CLI users on its own, as v0.2.0.** It fixes a race that
  exists today when `brain watch` runs alongside `brain chat` (design
  §5.1). So the mixed-version warning (design §5.2) lands in M0, not M2.
- **Before CR-5 is complete**, the server behaves as follows:
  - Until T2.3, knowledge runs on the existing in-memory chain
    (`src/pipeline/session.ts:60–75`). Shutdown step 4 waits for those
    promises, as `brain chat` does (`src/cli.ts:706–708`), and the
    `deferred` and `interrupted` events are never emitted.
  - Until T2.4, `capture.submit` returns `UNKNOWN_METHOD`.
  - Until T2.5, `knowledge.backlog` and `knowledge.runs` return
    `UNKNOWN_METHOD`, and `TurnDTO.knowledge` is omitted.
  - Until T1.7, the server never takes the loop-owner lock, never runs a
    loop, and runs no `repo.changed` poller, although protocol §3 says the
    server always polls. It reports `loopOwner: "other"` with no `owner`, so a
    `brain watch` running beside it is never blocked. T1.7 adds the
    try-lock and the loop together, as design §5.3 item 2 requires. A
    holder of the lock always runs the loop.

  The app treats `UNKNOWN_METHOD` on these methods as "feature absent", so
  M3 can be built against an M1 server.

  Protocol §8 doesn't describe such a window, because the protocol
  describes the finished v1. This is a staging decision for pre-release
  servers only, and no build that returns `UNKNOWN_METHOD` for these
  methods is released with the app.

**Owner decisions** (status as of 2026-10-02):

| Decision | Status | Blocks |
|---|---|---|
| CR-1 sign-off (design §15) | Approved | O1 still has to land before T0.4 |
| CR-10 sign-off | Approved | — |
| CR-7 sign-off; floor chosen from the T0.10a results | Waiting for T0.10a | T0.10b |
| CR-5 sign-off | Deferred | O2, M2 |
| Capture session target (design §14.5) | Decided: one per day | — |

## 3. Overview

```
M0 core concurrency  ── shippable as CLI v0.2.0
  T0.1 ci+spike ── T0.3 lock primitive ─┬─ T0.4a→b→c one lock ── T0.5 CAS ── T0.6 recovery
                                        ├─ T0.7 turn lock (CR-9)
                                        └─ T0.8 loop owner (CR-10)
  O1 (owner) ── before T0.4      T0.2 CR-6 ── before T0.4c      T0.9 CR-11 (no deps)
  T0.1 ── T0.10a git 2.39 CI ── T0.10b floor (CR-7)
  T0.4 ── T0.11 mixed-version warning
M1 service layer + RPC
  T1.1 CR-2 ── T1.3 framing ── T1.4 reads ── T1.5 send ──┬── T1.6 proposals ── T1.8 CR-4 diffs/history
  T1.2 CR-8 ──────────────────────┘                      └── T1.7 engine + repo.changed
M2 knowledge backlog (CR-5)
  O2 ── T2.1 store+baseline ── T2.2 outcome+eligibility ── T2.3 sweeper (+ RPC driver)
                                                               ├── T2.4 capture
                                                               └── T2.5 backlog over RPC
M3 Mac app            (starts after T1.3; each feature waits on its RPC task)
  T3.1 project ── T3.2 BrainKit ── T3.3 … T3.9
M4 hardening + release
  T4.1 … T4.5
```

The diagram shows the order within each milestone. Edges between
milestones are listed only in each task's `Depends:` line. For example,
T1.1 needs T0.5, T1.5 needs T0.7, T1.7 needs T0.8, and T2.3 needs T1.5, so
M2 does depend on M1.

These can run in parallel:
- T0.1, T0.2, T0.9 and T1.2 have no gate and no dependencies, so they
  can start now. T0.10a has no gate and starts after T0.1.
- T0.7 and T0.8 can each run next to T0.4. They share only the lock
  primitive from T0.3.
- M3 can run next to M2.

---

## M0 — Core concurrency (CLI v0.2.0)

### T0.1 — macOS CI job and platform lock test `[ci]` `[core]`
Depends: none. Gate: none.
- Add a `macos-latest` job to `.github/workflows/ci.yml`. Today there is
  only `ubuntu-latest` (`ci.yml:10`).
- Port the lock spike into `test/unit/sqliteLockPlatform.test.ts`. The
  source was `scripts/spikes/sqlite-lock-spike.ts`. Once the port exists,
  the spike file is deleted, and design §5.2's reference to it is updated
  to point at the test. (Done: the spike is now
  `test/unit/sqliteLockPlatform.test.ts`, and "spike A2"-style citations
  below name its checks.) It exercises `bun:sqlite` directly, not
  the new primitive, and pins the platform assumptions that design §5.2
  relies on: A1–A7, A8a, B1–B2, C0–C3b, D1–D2, E1–E4, F1, G0–G1 and
  H1–H4. A8 and C3c are informational. Its temp dirs are created with `mkdtemp` under the test temp root,
  never under `process.cwd()`.
  - After the plan review, the spike was already tightened, and the port
    keeps those changes:
    - A8 is informational. A8a first proves that the orphan really held the
      lock. A8 and A8a use a separate `orphan.sqlite`, so an orphan that is
      never collected cannot contaminate checks B–H. A7 is the guarantee.
    - C3 is split into three checks:
      - C3a: a lock-style holder on an initialized lock file leaves no
        journal behind.
      - C3b: a writer killed after spilling dirty pages leaves a genuinely
        hot journal, and the next `BEGIN IMMEDIATE` rolls it back.
      - C3c (informational): an uninitialized lock file creates a journal
        on every acquisition.
    - A6, B1 and D1 assert that the holder really acquired the lock.
    - H4 retries only on `SQLITE_BUSY`.
    - D's label no longer claims that the child inherited the lock's file
      descriptor.
    - H1–H4 cover the async wait shape that the implementation must use
      (design §5.2): `busy_timeout = 0` with async retries. They show that
      the event loop stays responsive, the deadline is honored, a waiter
      acquires once the holder dies, and 4 processes never hold the lock at
      once.
  - B1, B2, F1, G0 and G1 use a synchronous `busy_timeout`. They remain
    only as platform facts. The async shape is covered by H1–H4, and T0.3's
    own tests (including design §5.2 test 3) use it.
  - Timing assertions use generous bounds, so a slow CI runner doesn't make
    them flaky. Lower bounds are kept only where they carry meaning, for
    example "waited at least the deadline". The test runs in the main
    suite with explicit per-test timeouts (around 30 s), well above Bun's
    default of 5 s, because several checks take seconds.
- On macOS, record whether `bun:sqlite` links the system SQLite or Bun's
  bundled copy, and assert that whichever one it is passes the test. Don't
  assume either.

Tests: the ported spike, green on both runners.
Commit: `test: pin bun:sqlite lock and data_version behavior on linux and macos`

### T0.2 — Scripted model provider (CR-6) `[core]`
Depends: none. Gate: none.
- `BRAIN_MODEL_SCRIPT=<file>` selects a provider built on
  `MockModelProvider` (`src/extract/extractor.ts:211`; its streaming
  subclass is in `src/pipeline/mock.ts`). It answers chat, extractor
  and planner calls from a script, so that knowledge runs produce real
  mutations and proposals. Each process gets its own script file, so a
  cross-process test gives each writer its own call sequence.
- The script can hold **any** scripted call open: a chat reply, an
  extractor call or a planner call. It can also make any call fail with a
  retryable `ModelProviderError`. Together these cover streaming, bounded
  waits, knowledge runs in flight, crash-after-started-writing, and
  deferral.
- A held call waits for an external, file-based release signal, so a
  harness step in another process can release it.
- Every call is appended to a call log file, with its role and its input
  messages, so a test step can assert what a model call saw. An example
  is the extractor range in T2.3.
- The existing mock does no knowledge extraction (`src/cli.ts:555`).

Tests: a `brain chat --once` under a script yields a named mutation and a
proposal.
Commit: `test: scripted model provider for deterministic knowledge runs`

### O1 — Frozen-doc wording for CR-1 (owner)
Depends: CR-1 sign-off. Lands before T0.4.
Update the frozen docs so they match what design §5.2 now requires:
- `docs/spec.md` §12: "single-writer lock" becomes cross-process.
- `docs/spec.md` §17: recovery runs at startup and at the start of every
  drain, and gains an accept-reconciliation step.
- `docs/spec.md` §34: a proposal also becomes STALE when its accepted
  mutation is invalidated at rebuild.
- `docs/invariants.md` I-11: the one lock also covers execution and
  recovery.
- `docs/invariants.md` I-12: "on startup" becomes "at startup and at the
  start of every drain", which is design §5.2's wording.

### T0.3 — Kernel-released lock primitive (CR-1) `[core]`
Depends: T0.1. Gate: CR-1.
- Rewrite `src/sync/lock.ts` as design §5.2 describes:
  - a SQLite `BEGIN IMMEDIATE` on one file per lock under
    `runtime/locks/`;
  - three wait modes, and every one of them is asynchronous. Each uses
    `busy_timeout = 0` with async retries and backoff, never a blocking
    `busy_timeout`:
    - blocking, with no deadline, for the worktree lock and for
      `brain watch` on the loop-owner lock;
    - bounded, with a deadline, for turn-lock writers;
    - try-lock for sweeps, queries, the knowledge lock, and the RPC server
      on the loop-owner lock;
  - handles that stay strongly reachable while held;
  - each lock file initialized once, with a committed
    `PRAGMA user_version = 1` (design §5.2), so that an acquisition writes
    nothing. Creation must not race:
    - Lock connections never create the file. `bun:sqlite` creates a
      missing file by default, and a contender that did so would leave a
      0-byte file, so every acquisition would journal (spike C3c).
    - Open with `{create: false, readwrite: true}`. With `create: false`
      alone, `bun:sqlite` throws `SQLITE_MISUSE`. With both options, a
      missing file throws `SQLITE_CANTOPEN` (verified), never `ENOENT`,
      and `SQLITE_CANTOPEN` also covers missing directories and permission
      errors. So route to the init path on `existsSync(file) === false`
      before opening, not on the error.
    - The init path initializes a temp file and `link()`s it into place,
      which fails with `EEXIST` if another process won the race. Either
      way, the caller then opens.
    - It never uses `rename`. Renaming over a lock file that is in use
      would give later openers a different inode than the holder, and
      they would no longer exclude each other;
  - an informational side file with the holder's kind, pid and start time.
    `brain doctor` uses it to report a live holder of the worktree lock
    that has held it for a long time (design §5.2).
- The primitive is not re-entrant, even within one process. A second
  connection gets `SQLITE_BUSY` (spike A2), so nested acquisition in
  blocking mode deadlocks. T0.4 depends on this.
- Keep the signature `withRepoWorktreeLock(runtimeDir, fn)`
  (`docs/spec.md` §21.1 line 351, fixture 3.12).
- Why this comes first: T0.4 lengthens how long the lock is held, past the
  old 60 s eviction rule (`src/sync/lock.ts:18,56`).

Tests:
- Rewrite `test/unit/lock.test.ts`. The dead-pid and 60 s cases become
  "the holder is SIGKILLed, and a waiter acquires".
- Add a hold test under `Bun.gc(true)`.
- The event loop stays responsive while a waiter waits in each mode.
- Add design §5.2 test 3 (SIGKILL with two waiters).
- Two processes create the same missing lock file at once. Exactly one
  file results, it is initialized, and both processes then exclude each
  other on it.
- Fixture 3.12 must still pass unchanged.

Commit: `feat(lock): kernel-released sqlite lock primitive`

### T0.4 — One lock across every coordinator write path (CR-1) `[core]`
Depends: T0.3, O1, T0.2 (for test 1 in T0.4c). Gate: CR-1.
This is the riskiest core change, so it is split into three commits, and
the suite must be green after each one.

Moving the lock out of the callees and into the top-level methods has to
happen in **one** commit. Today the callees are the ones that lock
(`src/core/integrate.ts:52`, `src/core/coordinator.ts:78`), and no caller
holds the file lock except `syncOnce` (`src/core/coordinator.ts:197`). So
de-locking the callees alone would leave integrate and rebuild with no
cross-process exclusion. The suite would not notice, because the
in-process `Serial` still serializes them. Doing it the other way round,
locking the tops first, would nest the non-re-entrant primitive and
deadlock (T0.3).
- **T0.4a** — Every method in design §5.2's list takes the lock exactly
  once: `submit`, `execute`, `drainQueued`, `integrate`, `rebuild`,
  `syncOnce`, `recover`, `reconcileIndex`, `acceptProposal`,
  `rejectProposal` and `listProposals`. In the same commit,
  `integrateOnce` and `rebuildUnlocked` stop acquiring the lock. Tests
  cover each method: while a holder in another process has the lock, the
  method waits.
  Commit: `feat(coordinator): every write path under the worktree lock`
- **T0.4b** — `openCoordinator` runs `ensureAgentWorktree` under the lock
  (`src/core/coordinator.ts:333`). It stays in `openCoordinator`, because
  the harness opens coordinators without `recover()`
  (`test/harness/index.ts:352`).
  Commit: `fix(coordinator): ensure agent worktree under the lock`
- **T0.4c** — `Queue.enqueue` uses an immediate transaction
  (`src/core/queue.ts:110–114`). This commit also adds design §5.2 test 1:
  `brain watch` alongside two `brain chat --once` processes.
  Commit: `fix(queue): immediate enqueue; cross-process single-writer test`

### T0.5 — Compare-and-set proposal decisions (CR-1) `[core]`
Depends: T0.4. Gate: CR-1.
- `ProposalStore.decide` takes the status it expects to find and updates
  only if it still holds (`decide`, `src/proposal/store.ts:125`; its
  comment at `:121` documents that there is no from-status guard today). The allowed
  transitions are those in design §5.2.
- The PENDING check moves from the CLI (`src/cli.ts:440`) into
  `rejectProposal`.

Tests: design §5.2 test 2 (concurrent accept and reject).
Commit: `fix(proposals): compare-and-set decisions under the lock`

### T0.6 — Accept reconciliation and continuous recovery (CR-1) `[core]`
Depends: T0.5. Gate: CR-1.
- ACCEPTED proposal ↔ queue row reconciliation, as in design §5.2:
  - no row → rebuild the mutation, then enqueue, execute and integrate;
  - row in `REPLAN` → the proposal becomes STALE.
- The reconciliation runs in three places:
  - `recover()`, so that design §5.2 test 4 passes after a plain restart
    (`openRepo` → `recover()`, `src/cli.ts:212`);
  - the start of every `drainQueued`, together with spec §17 steps 1, 2
    and 4, all inside its one lock section;
  - the `REPLAN` → STALE check only, in every `listProposals` staleness
    refresh (design §5.2).
- The dead-`RUNNING` argument only holds once execution is under the lock,
  which is why this task comes after T0.4.

Tests:
- Design §5.2 test 4 (crash between the ACCEPTED write and the enqueue),
  using a crash hook for tests.
- A `RUNNING` row left by a SIGKILLed process is resolved by another
  process's next drain, without a restart.
- An accepted mutation invalidated at rebuild leaves its proposal STALE.

Commit: `feat(recovery): reconcile accepts and recover at every drain`

### T0.7 — Per-session turn lock (CR-9) `[core]`
Depends: T0.3. Gate: CR-1 (it uses the primitive).
- Add the turn lock described in design §5.4, with a bounded wait of about
  1 s.
- `appendTurn` allocates turn ids from the file while the lock is held,
  never from the cache (`src/conversation/store.ts:59,120–125`).
- `runTurn` holds the lock from the user append to the assistant append.
- `brain chat` prints an error on `SESSION_BUSY`.

Tests: the three §5.4 tests: held longer than the bound, released within
the bound, and both again across processes.
Commit: `feat(conversation): per-session turn lock and on-disk turn ids`

### T0.8 — Loop-owner lock (CR-10) `[core]`
Depends: T0.3. Gate: CR-10.
- `brain watch` holds the loop-owner lock for its lifetime, on a
  long-lived object (design §5.2, GC note), and waits if another process
  holds it.
- It writes `watch.pid` only after acquiring the lock. Today it writes the
  file right after opening the repo (`src/cli.ts:492–495`).
- `brain doctor` reports ownership from the lock's side file
  (`src/config/doctor.ts:275–282`).
- Whoever acquires the lock runs a forced tick (`src/cli.ts:528`).
- Update the `brain watch` section of the README.

Tests:
- A second `brain watch` waits while the first holds the lock.
- After the first is SIGKILLed, the second takes over within one interval.
- A stale `watch.pid` naming a reused pid changes nothing.

Commit: `feat(watch): loop-owner lock`

### T0.9 — Anthropic credentials from env (CR-11) `[core]`
Depends: none. Gate: none.
- `ClaudeModelProvider` accepts `apiKey`, `authToken` and `baseURL`
  (`src/model/claude.ts:47–53,102`).
- `createModelProvider(env)` passes them in (`src/model/index.ts:74`), as
  `src/config/doctor.ts:99–102` already does.

Tests: a provider built from a private env never reads `process.env`.
Commit: `feat(model): anthropic credentials from the passed env`

### T0.10a — Git 2.39 CI job (CR-7 input) `[ci]`
Depends: T0.1. Gate: none.
- Run the full suite on Git 2.39.x in CI (a container or a pinned build),
  as a job with `continue-on-error`, so the suite stays green while the
  floor is undecided.
- Report which tests fail, if any. Its results are the input to the CR-7
  decision.

Commit: `ci: run the suite on git 2.39`

### T0.10b — Git version floor (CR-7) `[core]`
Depends: T0.10a. Gate: CR-7.
- From T0.10a's result, either lower `MIN_GIT_VERSION`
  (`src/config/doctor.ts:27`), or name the feature that needs 2.40.
- Update the README.
- Drop `continue-on-error` from the 2.39 job, or remove the job if the
  floor stays at 2.40.

Commit: `chore: git floor from 2.39 test results`

### T0.11 — Mixed-version warning `[core]`
Depends: T0.4. Gate: CR-1.
- `brain doctor` warns when the `brain` on `PATH` differs from the running
  binary (design §5.2, §5.5 item 9).
- The README states that mixed versions are unsupported from v0.2.0 on.

Commit: `feat(doctor): warn on mixed brain versions`

**M0 exit:** tag `v0.2.0`. All of design §5.2's tests pass on Linux and
macOS.

---

## M1 — Service layer and RPC

### T1.1 — Service layer (CR-2) `[core]`
Depends: T0.5. T0.5 moves the reject PENDING check out of
`src/cli.ts:440`, and extracting the CLI bodies before that would move the
same code twice. The cost is that CR-2 waits for the CR-1 sign-off. Gate:
none of its own.
- Extract `openRepo` (`src/cli.ts:204`) and the command bodies into
  `src/commands/`, and make `src/cli.ts` a thin adapter over it. The name
  avoids a clash with the existing `src/cli/service.ts`, which installs the
  launchd and systemd units.
- `runDoctor` can reuse an open coordinator and doesn't close one it
  didn't open (`src/config/doctor.ts:284`).
- `brain status` switches to the advisory pending count (protocol §5).

Tests: the existing CLI tests pass unchanged, apart from that one count.
Commit: `refactor: service layer shared by cli and rpc`

### T1.2 — Turn timestamps (CR-8) `[core]`
Depends: none. Gate: none.
- The store exposes `TurnLine.at` (`src/conversation/store.ts:29`).
  `ConversationTurn` stays unchanged.

Tests: every appended turn reads back with its timestamp, in session
order. Existing session files, which already store `at`, read back
unchanged.
Commit: `feat(conversation): expose turn timestamps`

### T1.3 — RPC framing and lifecycle (CR-3) `[rpc]`
Depends: T1.1, T0.2, T0.9 (so that `ANTHROPIC_*` keys from `initialize.env` reach the provider). Gate: none.
- `brain rpc --stdio` implements protocol §1–§3:
  - stdout carries protocol messages only, and `console.log` is redirected
    to stderr;
  - request, event, result, error and notification framing;
  - the four pre-`initialize` methods;
  - `initialize` with the private env (§3), `ALREADY_INITIALIZED`, and
    `EngineInfo` with its staging value `loopOwner: "other"` (§2). Every
    provider the server builds, and `doctor.run`'s live check, uses
    T0.9's isolated mode. `src/config/doctor.ts:99–102` currently falls
    back to `process.env` (design §10);
  - `shutdown` with its five drain steps (step 4 in its pre-CR-5 form,
    §2 above);
  - `cancel`.
- Add the transcript harness `test/rpc/`, with these matching rules:
  - Messages that belong to a request (its events and its terminal
    message) match in order **per request id**. Messages of different
    requests may interleave in any order (protocol §2). For example, a
    `cancel` result and the cancelled send's `CANCELLED` error can arrive
    either way round.
  - Notifications, which carry no id, match as an unordered multiset
    within a window. A window runs from one client message or step to the
    next, and the last window runs to the end of the transcript, so
    notifications that arrive after the final client message are matched
    too.
  - **Advancing.** The harness sends the next client message, or performs
    the next step, only once every earlier `s2c` line has matched,
    including the notifications expected in the current window. The
    trailing window ends when the server exits after `shutdown`, or after
    a fixed deadline in a transcript that does not shut down. A window that
    expects no occurrence of a polling type accepts any number of them.
  - **Steps.** A third line kind, `{"dir": "test", "step": {…}}`, names an
    out-of-band action that the Bun harness performs at that point. Step
    handlers include:
    - spawning, SIGKILLing or awaiting a process: `brain watch`,
      `brain chat --session`, `brain index`, or another `brain` writer;
    - restarting the server under test, which gives a new process and a
      new `initialize` in the same transcript;
    - releasing or holding a test hook, such as a held-back sweep, a held
      reply, or a crash point;
    - seeding or editing files under `BRAIN_HOME`. Examples: a legacy
      session file with no progress row, for T2.5's first-start
      transcript, which no CR-5 binary can produce; or a stale `watch.pid`
      naming a reused pid, for T1.7.

    Handlers are named, and they live next to the harness. Each handler
    lands with the first task whose transcripts use it, so T1.3 ships only
    the handlers its own transcripts need. The Swift replay (T3.2) skips
    `test` lines, because it only replays `s2c` into the decoder and
    reducers.
  - A transcript's first line is a header,
    `{"asserts": {"notifications": [<type>, …]}}` (protocol §9). It lists
    the notification types the transcript asserts, and an empty list means
    "asserts none". The harness ignores every other type, so polling
    notifications (`repo.changed`, `engine.*`) added by later tasks don't
    force earlier transcripts to be re-recorded.

    A transcript that asserts a type receives every occurrence of that type
    in the window. The exception is the polling types, `repo.changed` and
    `engine.tick`, which are matched as "at least one matching
    occurrence", because how many polls fall inside a window depends on
    timing.
  - **Subset matching for server messages.** Every field in the expected
    message must match. Extra fields in the actual message are ignored,
    in line with protocol §2's rule that clients ignore unknown fields.
    So additive fields, such as `TurnDTO.knowledge` in T2.5, leave earlier
    transcripts green.
  - **Matchers live beside the message, never inside it.** The `msg` of an
    `s2c` line is always the concrete message as recorded, so the Swift
    replay (T3.2) can decode it with the real `Codable` types. An optional
    sibling `match` field maps a JSON Pointer inside `msg` to a matcher,
    and only the Bun harness applies it. Matchers:
    - `"<ulid>"`, `"<sha>"`, `"<iso>"`: the value has that form.
    - `"<any>"`: any value, including an object or an array.
    - `{"$contains": [x, …]}`: the array contains every listed element,
      and others may be present too.

    With no matcher, a value matches exactly. Arrays therefore match
    exactly unless a `$contains` applies.
  - `repo.changed`'s `domains` always gets a `$contains` matcher. One poll
    often catches several domains at once, or splits them across polls. A
    Human Sync commit, for example, is followed in the same tick by
    integrate and reconcile. These move `agentHead` and `indexedCommit` in
    separate lock sections, so a test should assert only the domain it
    needs. New domains, such as
    `knowledge` in T2.5, are additive (protocol §8).
  - **Staging values get `"<any>"`.** "Handshake transcripts" means exactly
    the two that T1.7 owns: with a daemon and without one. Every other
    transcript recorded before T1.7, including T1.3's first-run and
    `ALREADY_INITIALIZED` transcripts, puts `"<any>"` on `/data/engine`
    of the `initialize` result and on the `engine.status` result.
    Transcripts recorded from T1.7 on may assert real values. The staging
    `loopOwner: "other"` (§2) changes at T1.7, and only the two handshake
    transcripts assert it.

Tests (protocol §9): first run, and `ALREADY_INITIALIZED`.
Commit: `feat(rpc): stdio server, lifecycle, transcript harness`

### T1.4 — Read methods `[core]` `[rpc]`
Depends: T1.3, T1.2 (`TurnDTO.at`). Gate: none.
- `repo.status`, `engine.status`, `conversation.list`,
  `conversation.create`, `conversation.get` (with paging), `notes.search`,
  `notes.list`, `notes.get`, `mutations.list`, and `proposals.list`, all as
  in protocol §4.
- The core function for the paths that differ between `main` and agent
  HEAD (CR-4). `notes.get` needs it for `NoteDetail.pendingIntegration`,
  and T1.8 exposes it as `repo.pendingIntegration`.

Tests: one transcript per method, plus paging edge cases.
Commit: `feat(rpc): read methods`

### T1.5 — `conversation.send` and knowledge notifications `[rpc]`
Depends: T1.4, T0.7, T0.2. Gate: none.
- Streaming `reply.delta`, then `result`.
- `knowledge.event` with `summary` on `done`, still from the in-memory
  chain (§2).
- `SESSION_BUSY` with the bounded wait.

Tests (protocol §9):
- send with streaming;
- the two turn-lock cases, held longer than the bound and released within
  it. The held case is repeated with the second writer being
  `brain chat --session` in another process (protocol §9). The
  cross-process pair from design §5.4 belongs to T0.7;
- a `NOOP` mutation reported as success;
- a cancelled send followed by `shutdown`;
- shutdown with a knowledge run in flight;
- shutdown while a reply is pending, in its pre-CR-5 form. The trailing
  window after the `shutdown` request contains the turn's knowledge
  `done`, and the server exits only after that. T2.3 re-records this
  transcript in its final form.
Commit: `feat(rpc): conversation.send with streaming`

### T1.6 — Proposal decisions `[rpc]`
Depends: T1.4, T0.5, T0.6, T1.5 (the test proposals come from scripted knowledge runs, protocol §9). Gate: none.
- `proposals.accept` and `proposals.reject`, with the `REPLAN` result
  handling from protocol §4.
- `proposals.changed`: sent when this server creates or decides a
  proposal, or when a `proposals.list` refresh marks one STALE. That
  refresh includes T0.6's `REPLAN` → STALE check. The same event for
  `proposals.get` is added in T1.8, which implements that method.

Tests (protocol §9): accept, accept of a stale proposal, reject, and
concurrent accept and reject. Each transcript creates its proposal through
a scripted knowledge run, started by `conversation.send`, and waits for it
on `proposals.changed`, never on `knowledge.event`. That keeps these
transcripts unaffected by T2.3. For the concurrent case, a hold hook in the
first decider fixes which one enters the critical section first, so the
recorded winner is deterministic. The core-level race with an unfixed
order is design §5.2 test 2, in T0.5.
Commit: `feat(rpc): proposal decisions`

### T1.7 — Engine loop and change detection `[rpc]`
Depends: T1.5 (the server must be a writer for the CR-1 and external-NOOP
tests), T0.8. Gate: none.
- Try-lock the loop-owner lock at `initialize` and then every
  `intervalMs`. While the server holds the lock, it runs the in-process
  Human Sync watcher and `watchTick`. The watcher's `sync` must be
  `coord.syncOnce`, as `src/cli.ts:510–511` passes it. The default in
  `src/sync/humanSync.ts:86` takes the file lock directly and bypasses the
  coordinator.
- The `EngineInfo` staging value from T1.3 ends here. T1.7 records the
  two handshake transcripts. Every other transcript already matches
  `engine` with `"<any>"` (T1.3), so none needs re-recording.
- A server that acquires the loop-owner lock runs a forced tick at once
  (design §5.2 continuous recovery, §5.3 item 2), as T0.8 does for
  `brain watch`.
- The `engine.tick` method (protocol §4).
- Emit `engine.loopOwner`, `engine.tick`, `engine.humanSync` and
  `engine.error`.
- Implement the `repo.changed` poller: one dedicated poll connection per
  database, the domain table from protocol §5 (`knowledge` is added in
  T2.5), and the advisory `pendingProposals`.

Tests (protocol §9):
- handshake without a daemon, and with a daemon. An idle `brain watch`
  tick writes nothing (`src/core/integrate.ts:32–36`,
  `src/index/reconcile.ts:445`, `src/cli/watch.ts:101`), so the
  with-daemon transcript uses a step that edits a note in the user
  worktree. The daemon's Human Sync then commits it, and a `repo.changed`
  whose `domains` contains `"git"` follows. The test repo sets
  `sync.quiescence_ms` to a short value, and the window deadline exceeds
  it. The default is 1500 ms (`src/markdown/repo.ts:15`), and Human Sync
  commits only quiescent edits (`src/sync/humanSync.ts:63`);
- a SIGKILLed `brain watch` hands the loop to the server;
- an external `NOOP` produces a `repo.changed` whose `domains` contains
  `"queue"`;
- external embeddings produce a `repo.changed` whose `domains` contains
  `"index"`. The server's own forced tick embeds every stale note as soon
  as it owns the loop (`src/cli/watch.ts:101`), and a later `brain index`
  would then have nothing left to write. So this transcript runs as
  follows:
  1. A `brain watch --no-embeddings` (`src/cli.ts:74`) holds the loop, so
     the server reports `loopOwner: "other"` and never embeds.
  2. A step adds a note. The daemon's Human Sync commits it and reconcile
     indexes it, without embedding. The window after this step expects a
     `repo.changed` whose `domains` contains `"index"`. That is the write
     that has to be absorbed before step 3. The `git` change may arrive in
     the same notification or an earlier one, because on the rebuilt-only
     path `agentHead` and `indexedCommit` move in separate lock sections
     (`src/core/integrate.ts:58–68`, `src/cli/watch.ts:96–99`).
  3. A step runs `brain index`, which embeds that note at an unchanged
     HEAD. The transcript calls no method that embeds.
- the CR-1 scenario with the RPC server as one of the writers.

Commit: `feat(rpc): engine loop and repo.changed`

### T1.8 — Diffs, history, pending integration (CR-4) `[core]` `[rpc]`
Depends: T1.4, T0.6, T1.6 (the `proposals.changed` emitter; its test proposals come from scripted knowledge runs). Gate: none.
- `proposals.get` (protocol §4): the `FileDiff` for a proposal compares
  the snapshot blob with the `writes`, and sets `beforeUnavailable` when
  that blob is gone. The staleness refresh, including T0.6's `REPLAN` →
  STALE check, and the diff run in one lock section. When that refresh
  marks a proposal STALE, `proposals.get` emits `proposals.changed`, using
  T1.6's emitter.
- `FileDiff` for commits.
- `history.list` and `history.diff` over `main`, with trailers from
  `parseTrailers` (`src/git/git.ts:231`).
- `repo.pendingIntegration`, which exposes the function from T1.4.

Tests: transcripts for each method, plus a proposal whose snapshot blob has
been garbage-collected. As in T1.6, proposals come from scripted
knowledge runs, and the transcripts wait on `proposals.changed`.
Commit: `feat: diffs, history and pending-integration paths`

---

## M2 — Knowledge backlog (CR-5)

### O2 — Frozen-doc note for CR-5 (owner)
Depends: CR-5 sign-off. Lands before T2.1.
- Add a note in `docs/spec.md` near §36 that knowledge runs are driven
  from a durable per-session backlog.
- Note that turns whose reply failed, and captured turns, are processed
  without a reply (design §5.5 item 2). The pipeline stages themselves
  don't change.

### T2.1 — Backlog store and baseline `[core]`
Depends: T0.7, O2. Gate: CR-5.
- Create `knowledge.sqlite` with session progress and run history (design
  §5.5 items 1 and 7).
- `createSession` writes the progress row before it creates the session
  file.
- Legacy sessions get a baseline, written only under the turn lock
  (item 9).

Tests (store level): on the first start on an existing repo, no run is
recorded for any historical turn, every legacy marker equals the
session's last user turn, and those turns report `before-backlog`. Both
baseline orders are covered: a writer baselines first, or a sweep does,
controlled by a test hook. That a new turn in a legacy session is then
processed is tested in T2.3, which has the sweeper.
Commit: `feat(knowledge): backlog store and legacy baseline`

### T2.2 — Structured outcome, eligibility, fixed range `[core]`
Depends: T2.1. Gate: CR-5.
- `processTurnForKnowledge` returns `deferred` or `completed`, based on
  `ModelProviderError.retryable` (`src/model/claude.ts:56`,
  `src/model/openrouter.ts:87,103`) (item 4).
- The eligibility rule takes the lock before checking anything (item 2).
- Each run reads the range fixed by its turn, not the whole session as
  today (`src/pipeline/session.ts:100`).

Tests (unit): the two eligibility cases in item 2, the lock-first
ordering (a reply lands between listing and try-lock), and the fixed
range. The protocol §9 transcripts for these belong to T2.5.
Commit: `feat(knowledge): outcome, eligibility and fixed ranges`

### T2.3 — Backlog sweeper `[core]` `[rpc]`
Depends: T2.2, T1.5. Gate: CR-5.
- The knowledge lock is taken with try-lock, turns are processed in strict
  order, and the marker advances.
- A run durably records that it has started writing; a run interrupted
  after that point finishes as `interrupted`. Deferred runs retry with
  backoff (items 3–6).
- The sweeper replaces the in-memory chain (`src/pipeline/session.ts:60–75`).
- `brain chat` REPL, exit and `--wait` behave as in item 8.
- **The RPC server's sweep driver** (design §5.5 item 8, first bullet):
  every `intervalMs` it sweeps every session with a non-empty backlog,
  whoever owns the loop. It emits `knowledge.event` for the runs it
  performs, including the new `deferred` and `interrupted` variants. This
  has to land in the same commit that removes the chain. Otherwise T1.5's
  "send → knowledge `done`" transcript would go red, because nothing would
  start knowledge runs.
- Shutdown step 4 takes its final form: finish the run in progress, and
  start no new ones.
- Under `BRAIN_MODEL_MOCK=1`, the mock's extractor returns
  `{"candidates": []}` (`src/pipeline/mock.ts:54`), so the run is
  **completed** with zero candidates, not deferred. That
  keeps the CI smoke step `brain chat --once hello --wait`
  (`.github/workflows/ci.yml:29`) exiting, because `--wait` now waits for
  the marker.

Tests:
- the item 8 test: a reply held open while another process sweeps, plus
  the variant where the reply fails. The other sweeper is a second
  `brain rpc --stdio` on the same repo. `brain watch` never runs knowledge,
  and a `brain chat` on the same session would hit `SESSION_BUSY` before
  it could sweep;
- backlog order, core level;
- a crash after the run started writing leads to `interrupted`, with no
  re-run;
- a new turn in a legacy session is processed, in both baseline orders
  (item 9 acceptance, last sentence);
- **Re-record every transcript, from any earlier task, whose header
  asserts `knowledge.event`**, because the knowledge events change here.
  T1.6 and T1.8 wait for their proposals on `proposals.changed`, which
  T2.3 does not change, so none of their transcripts is affected. The
  rule decides which transcripts are affected; the list below names the
  known ones:
  - "Send with streaming" and "a `NOOP` reported as success" now get their
    knowledge events from the sweep driver.
  - "Cancelled send then shutdown" and "shutdown while a reply is pending"
    take their final form. The trailing window after `shutdown` contains
    no `knowledge.event`. After a restart step, the next window contains
    the turn's knowledge `done`. A step then checks the scripted
    provider's call log (T0.2) to confirm that the extractor call for that
    turn included the reply. `KnowledgeEvent` and `KnowledgeRun` carry no
    range, so this can't be asserted over the wire.
  - "Shutdown with a knowledge run in flight" now finishes the run in
    progress and starts no new one.
  - The turn-lock transcripts assert no knowledge events, so they are not
    re-recorded (see the T1.3 matching rules).

Commit: `feat(knowledge): durable backlog sweeper`

### T2.4 — Capture entry point `[core]` `[rpc]`
Depends: T2.3. Gate: CR-5.
- A `capture.submit` path that appends one user turn and makes no reply.
  The turn goes to the current day's capture session, which is created on
  first use and marked as a capture session in its header (design §14.5).

Tests (protocol §9): capture while the provider fails.
Commit: `feat: quick capture entry point`

### T2.5 — Backlog over RPC `[rpc]`
Depends: T2.3, T1.7. Gate: CR-5.
- `knowledge.backlog`, `knowledge.runs` (with cursor), and
  `TurnDTO.knowledge`, including the try-lock probe for `awaiting-reply`.
- The `knowledge` domain in `repo.changed`.

Tests (protocol §9):
- a zero-candidate run finished by another process;
- the first start on an existing repo, including a send before any sweep;
- backlog eligibility: a reply held open while a second
  `brain rpc --stdio` sweeps, observed as `awaiting-reply`;
- eligibility lock ordering;
- backlog order, observed through `knowledge.backlog`.

Commit: `feat(rpc): knowledge backlog surface`

---

## M3 — Mac app

Each feature task depends on the RPC task for its methods, and is tested
against the recorded transcripts before it runs against a live server.

| Task | Scope | Depends |
|---|---|---|
| T3.1 | Xcode project in `apps/mac/`. Bundle the `darwin-arm64` and `darwin-x64` binaries (`bun run build:all`). Developer ID signing, the hardened-runtime entitlements for Bun verified on a real build (design §11), notarization in CI. | T1.3 |
| T3.2 | BrainKit: spawn the process, the JSONL codec, request correlation, the notification stream, `Codable` DTOs whose enums all have `unknown(String)`, treating `UNKNOWN_METHOD` as "feature absent", and the transcript replay tests (protocol §9). | T3.1 |
| T3.3 | First run and Settings: the repo picker, `repo.init`, `doctor.run`, keys in Keychain passed as `initialize.env`, restarting the child when settings change (design §10), and a warning when the `brain` on `PATH` differs from the bundled version (design §5.5 item 9). | T3.2, T0.9 |
| T3.4 | Conversation: the session list, streaming, `SESSION_BUSY` handling, and per-turn knowledge chips (these render only once T2.5 exists). | T3.2, T1.5 |
| T3.5 | Activity and notifications: `mutations.list`, the backlog views (these render only once T2.5 exists; until then `UNKNOWN_METHOD` means the feature is absent), re-fetching on `repo.changed`, and notifications only for proposals and failures (design §4). | T3.2, T1.7 |
| T3.6 | Proposal Inbox: diff rendering, accept and reject, and the `REPLAN` / STALE experience (design §7). | T3.2, T1.6, T1.8 |
| T3.7 | Knowledge Browser and Search: `notes.*`, the pending-integration badges, "Open in external editor" (design §8). | T3.2, T1.4, T1.8 |
| T3.8 | History and diff views. | T3.2, T1.8 |
| T3.9 | Quick Capture panel with a configurable global shortcut, and the menu bar (design §4, §9). | T3.2, T2.4 |

Commits: `feat(app): <surface>`, one per task.

---

## M4 — Hardening and release

| Task | Scope | Depends |
|---|---|---|
| T4.1 | Resilience: the child crashes and is relaunched, `recover()` is idempotent, the loop moves between processes, and SIGKILL mid-shutdown has only the bounded consequences in protocol §3, including completion of an interrupted accept. | T0.6, T1.8, T1.7, T2.3, T3.2 |
| T4.2 | Offline: the provider is down, and Browser, Search (with `hashing`), History and Inbox keep working. Replies fail visibly, and captures are deferred and later processed (design §12). | T2.4, T3.9 |
| T4.3 | End-to-end acceptance with the scripted provider, conversation first. First run and init. Send a turn; the reply streams, and "Knowledge updated" arrives. The mutation appears in Activity and History with trailers. The note is edited in an external editor, and Human Sync commits it. A proposal shows its diff and is accepted; a second proposal goes stale. A capture is made while offline and processed once back online. Quit with a reply in flight. `brain watch` runs alongside the app. | all of M3, T2.5 |
| T4.4 | Performance and macOS conventions: launch time, streaming latency, VoiceOver, keyboard navigation, dark mode. | all of M3 |
| T4.5 | Release: a notarized build, and the README's app section. | T4.1–T4.4 |

## 4. Coverage check

Every design §15 core change maps to at least one task:

| CR | Tasks |
|---|---|
| CR-1 | O1, T0.3, T0.4a–c, T0.5, T0.6, T0.11 |
| CR-2 | T1.1 |
| CR-3 | T1.3–T1.8, and the RPC parts of T2.3–T2.5 |
| CR-4 | T1.4 (pending paths), T1.8 |
| CR-5 | O2, T2.1–T2.5 |
| CR-6 | T0.2 |
| CR-7 | T0.10a, T0.10b |
| CR-8 | T1.2 |
| CR-9 | T0.7 |
| CR-10 | T0.8 |
| CR-11 | T0.9 |

Each test named in design §5.2, §5.4, §5.5 items 8–9 and protocol §9
belongs to exactly one task:

| Test | Task |
|---|---|
| design §5.2 test 1 (watch + two chats) | T0.4c |
| design §5.2 test 2 (accept/reject race) | T0.5 |
| design §5.2 test 3 (SIGKILL, two waiters) | T0.3 |
| design §5.2 test 4 (crash between ACCEPTED and enqueue) | T0.6 |
| design §5.4 turn-lock tests | T0.7 |
| design §5.5 item 8 test | T2.3 |
| design §5.5 item 9 acceptance | T2.1 (the store-level half), T2.3 (the "new turn is processed" half); each half belongs to exactly one task |
| protocol §9: first run, `ALREADY_INITIALIZED` | T1.3 |
| protocol §9: handshakes, watch SIGKILL, external NOOP, external embeddings, CR-1 scenario via RPC | T1.7 |
| protocol §9: turn lock held (with its cross-process variant) / released within the bound | T1.5 |
| protocol §9: send with streaming, cancelled send then shutdown | T1.5 (re-recorded in T2.3) |
| protocol §9: proposal accept, stale accept, reject, concurrent accept/reject | T1.6 |
| protocol §9: `NOOP` reported as success, shutdown with a knowledge run in flight | T1.5 (re-recorded in T2.3) |
| protocol §9: shutdown while a reply is pending | T1.5 (pre-CR-5 form), T2.3 (final form); each form belongs to exactly one task |
| protocol §9: eligibility lock ordering, backlog eligibility (reply held open while another process sweeps), backlog order | T2.5 |
| protocol §9: capture while the provider fails | T2.4 |
| protocol §9: zero-candidate run by another process, legacy first start including a send before any sweep | T2.5 |

## 5. First agent run

Start with the tasks that have no gate: **T0.1, T0.2, T0.9 and T0.10a**,
in that order, one commit each. Stop there. Report two results: the macOS
result from T0.1, since T0.3 depends on it, and the Git 2.39 result from
T0.10a, since the CR-7 decision depends on it. The next run, after CR-1 is signed off, is O1 and
then T0.3.

## 6. Deferred (not in this plan)

- Revert (design §14.1).
- Aborting a model call on `cancel` (§14.2).
- Multi-repo (§14.3).
- The socket transport (§14.4, §5.3).
- Re-processing history (§14.6).
- Giving `brain watch` a model provider (§5.5 item 8).
- Fixing the CLI's projection of `config.toml` onto `process.env`
  (design §10).
- `todo.md` follow-ups F1, F2, F4 and F5.
