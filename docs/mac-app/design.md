# Brain for Mac — Client Design

Status: Draft, for review
Date: 2026-09-29
Companions: `protocol.md` (wire contract), `implementation-plan.md`
(ordered tasks)

> This document does not redefine Brain's mutation, knowledge, Git,
> provenance, permission, or execution semantics.
>
> `docs/design.md` and `docs/invariants.md` remain authoritative.
>
> In case of conflict, those documents take precedence.

When this document needs something the core does not provide yet, it names
a required core change (`CR-n`, listed in §15) instead of assuming the
behavior exists. Every statement about current behavior cites `docs/` or
`src/`.

---

## 1. What it is

Brain remains the product and the core. The Mac app is a native client and
interaction surface for Brain. It is not a second implementation of Brain.

Conversation remains the interface (`docs/design.md` §3). The app is a
native conversation surface plus the windows that let the user see and
control what the agent did: persistent knowledge, agent activity the user
can follow, and Git-backed mutations the user can trust.

## 2. What it is not

- **Not an editor.** `docs/design.md` §17 says: "No editor; Markdown is
  edited with external tools." The Knowledge Browser is for inspection and
  navigation only. Its edit action is "Open in external editor".
- **Not a second engine.** Swift contains no mutation engine, state
  machine, precondition logic, permission table, provenance rules, Git
  calls, or Markdown writer.
- **Not a CLI replacement.** `brain` stays fully usable. The CLI, a running
  `brain watch`, and the app work on the same repo at the same time and
  share one `BRAIN_HOME`. CR-1 is what makes this safe (§5).

## 3. Boundary

```
┌───────────────────────────────────────────┐
│ Brain.app  (SwiftUI / AppKit)             │
│  Conversation · Quick Capture · Proposals │
│  Activity · Knowledge Browser · History   │
│  Settings · Notifications · Menu bar      │
│  BrainKit: process + JSONL codec + DTOs   │
└──────────────────┬────────────────────────┘
                   │ JSONL over stdio (protocol.md)
┌──────────────────▼────────────────────────┐
│ brain rpc --stdio   (Bun / TypeScript)    │
│  RPC adapter ─┐                           │
│  CLI adapter ─┴─ service layer (CR-2)     │
│  coordinator · executor · queue · rebuild │
│  planner · extractor · validators · index │
└──────────────────┬────────────────────────┘
                   ▼
   knowledge repo (main) + $BRAIN_HOME/repos/<repo_id>/
```

**The Mac client does not own mutation semantics.** Swift knows only the
DTOs in `protocol.md` §7. It decodes them, displays them, and sends user
decisions back as RPC calls. Concretely:

- Swift never re-derives a fact that core decides. Proposal staleness comes
  from `proposals.list`, which refreshes staleness in core
  (`src/core/coordinator.ts:261`). The app never compares hashes.
- Every Swift enum decoder has an `unknown(String)` case, so a
  `MutationState` added in TypeScript never crashes the app.
- CLI and RPC are thin adapters over one service layer extracted from
  `src/cli.ts` (CR-2). No behavior may exist in only one adapter.

## 4. Surfaces

`docs/design.md` §17 lists the v0 surfaces: Chat, Search, Note, Changes,
Proposal Inbox. The app maps them one-to-one and adds native affordances
around them.

| Surface | Core source | Notes |
|---|---|---|
| Conversation (Chat) | `runTurn`, `src/pipeline/session.ts:88` | The reply streams. "Knowledge updated · …" arrives later as a notification (§6). Sessions come from `ConversationStore.listSessions`. |
| Search | `hybridSearch`, `src/retrieval/hybrid.ts:85` | Shows the same lexical, semantic and graph signals that `brain search` prints. |
| Note (Knowledge Browser) | index `notes`; `backlinks` / `outlinks`, `src/index/backlinks.ts` | Read-only view at agent HEAD (§8). "Open in external editor" opens the file in the user worktree. |
| Changes (Activity + History) | queue rows; Git log + trailers | Activity shows live `MutationState`s. History lists commits with their `Actor` and `Mutation-ID` trailers (`docs/spec.md` §54) and shows a diff for each. |
| Proposal Inbox | `listProposals` / `acceptProposal` / `rejectProposal` | Shows the diff that core computed (CR-4). The only content decisions the user makes in the app are sending turns and captures, and accepting or rejecting proposals. `repo.init`, `initialize` (recover, fast-forward, reconcile) and `engine.tick` do engine maintenance only; they never decide content. |
| Quick Capture | capture entry point (CR-5) | Global panel. Saving never waits on a model (§9). |
| Notifications | `knowledge.event`, `engine.*` | Posted only for new proposals and for failures. Routine automatic mutations land quietly. |
| Menu bar | `repo.status`, `engine.status` | Pending proposals (from `repo.status`), loop owner (from `EngineInfo`), Quick Capture. |
| Settings / first run | `repo.init`, `doctor.run`, Keychain | Choosing a repo, including `brain init` for a new folder, happens before `initialize` (`protocol.md` §3). Provider, model and keys are covered in §10. |

Automatic operations (CREATE, ENRICH, LINK, ADD_ALIAS, ADDITIVE_EVOLVE;
`src/core/types.ts:89`) land exactly as they do from the CLI. The app only
makes them visible. It has no screen that writes Markdown and no "apply AI
change" action outside the Proposal Inbox.

## 5. Process model and the single writer

### 5.1 The current gap

`docs/spec.md` §12 says execution runs "under the coordinator's
single-writer lock". I-11 says Human Sync and integration share one
file-based `RepoWorktreeLock`. In the code, the single writer is only
enforced inside one process:

- `Serial` (`src/core/coordinator.ts:49`) is an in-process mutex.
- The file lock (`src/sync/lock.ts:95`) is taken only by Human Sync
  (`src/core/coordinator.ts:197`), integration
  (`src/core/integrate.ts:52`), rebuild (`src/core/coordinator.ts:78`), and
  the agent fast-forward in `openRepo` (`src/cli.ts:213`).
  `executeMutation` writes into the agent worktree without it.
- `openCoordinator` runs `ensureAgentWorktree`
  (`src/core/coordinator.ts:333`) before taking any lock. That function can
  `checkout`, `rm -rf` or `reset --hard` the agent worktree
  (`src/git/worktree.ts:58`). `recover()` then resets a dirty agent worktree
  and re-executes `RUNNING` rows (`src/core/coordinator.ts:202`). Neither
  step checks whether another process is in the middle of executing.
- Every CLI command opens through `openRepo` (`src/cli.ts:204`), so every
  command runs this sequence.

Concrete failure, which exists today in the workflow the README documents
(`brain watch` alongside `brain chat`):

1. `brain watch` is executing mutation M and has written M's files into the
   agent worktree (spec §12 step 6).
2. `brain chat` starts. `ensureAgentWorktree` sees a dirty worktree and
   runs `reset --hard`.
3. The watcher's `git status` (step 7) is now empty, so M is recorded as
   `NOOP`. The mutation is lost silently.

Other interleavings give `FAILED_INVALID_EXECUTION`, or a `RUNNING` row
executed twice. A long-lived app child next to a launchd `brain watch`
would turn this narrow window into a standing risk.

### 5.2 Required fix (CR-1)

Extend the one lock (I-11) to every coordinator path that writes. The
alternative, a lock held for the whole life of a process, was considered
and rejected in §15.

- Every public coordinator method that writes takes the file lock **exactly
  once**, at the top:
  - `submit`, `execute`, `drainQueued`
  - `integrate`, `rebuild`, `syncOnce`
  - `recover`, `reconcileIndex`
  - `acceptProposal`, `rejectProposal`, and `listProposals`, which writes
    STALE marks (`src/core/coordinator.ts:253`)

  Everything these methods call runs without taking the lock.
  `integrateOnce` and `rebuildUnlocked` stop acquiring it themselves.
  Today's rule that the lock is "never nested"
  (`src/core/coordinator.ts:5–9`) still holds.

  Two public writes stay outside the lock on purpose:
  - `submitProposal` is a single insert of a new id.
  - `enqueue` (`src/core/coordinator.ts:232`) is a single insert in an
    immediate transaction (see the last bullet). It never touches a
    worktree, and no locked section depends on the set of QUEUED rows
    staying fixed while it runs. A `drainQueued` that starts after the
    insert runs the row; one that started before leaves it for the next
    drain.
  `rejectProposal` currently takes neither the mutex nor the lock
  (`src/core/coordinator.ts:309`). Both are in the list above to make that
  explicit.
- **Proposal decisions are compare-and-set.** Today `ProposalStore.decide`
  has no from-status guard (`src/proposal/store.ts:121`), and the PENDING
  check for reject lives in the CLI (`src/cli.ts:440`). So process A can
  accept after process B checked PENDING, and B's REJECTED then overwrites
  A's ACCEPTED. Under CR-1:
  - The check and the decision run in one critical section under the lock.
    The PENDING check moves into `rejectProposal`, so it is no longer an
    adapter concern.
  - `decide` takes the status it expects to find and updates only if that
    status is still current (`UPDATE … WHERE status = ?`). The allowed
    transitions are PENDING → ACCEPTED / REJECTED / STALE (accept, reject,
    staleness refresh), and ACCEPTED → STALE only on the accept-then-REPLAN
    path (`src/core/coordinator.ts:299`).
  - A lost compare-and-set on reject surfaces as `PROPOSAL_NOT_PENDING`.
    On accept it surfaces as the existing `REPLAN` / `"STALE"` result.
- `openCoordinator` keeps calling `ensureAgentWorktree`, but calls it under
  the file lock. The fixture harness opens a coordinator and executes
  without calling `recover()` (`test/harness/index.ts:352`), so the call
  cannot move into `recover()`.
- **The kernel releases the lock.** Today the lock is a pid file, and
  reclaiming a stale one takes two separate steps: judge the file stale
  (`src/sync/lock.ts:100`), then rename whatever is at that path (`:66`).
  Suppose two contenders both judge an old lock stale. A renames it, then
  acquires a new lock. B then renames **A's new lock** away and acquires
  too. Both are now inside the critical section. No staleness rule can fix
  this. The 60 s age rule (`:18,56`) adds a second hazard: under CR-1,
  execute and integrate hold the lock through reconcile, which can take
  longer than 60 s, so a live holder would be evicted.

  CR-1 replaces the primitive with one the kernel releases when the holder
  dies. There is then nothing to judge and nothing to reclaim.
  - Recommended: hold a write transaction (`BEGIN IMMEDIATE`) on a
    dedicated lock file. `bun:sqlite` is already a dependency. SQLite's POSIX locks are dropped when the process exits, and
    its unix VFS also excludes connections within one process, which
    fixture 3.12 relies on.
  - Waiters retry on `SQLITE_BUSY` with the existing backoff, and there is
    no timeout. A hung but live holder blocks everyone, and
    `brain doctor` reports it.
  - **Keep lock connections strongly reachable.** If nothing references
    the `Database` that holds the lock, Bun garbage-collects it, which
    closes the connection and releases the lock while the holder is still
    alive. This was verified on 2026-09-29 (Linux, Bun 1.4.2, SQLite
    3.53.2): an unreferenced holder lost its lock on 37 of 40 probes, and
    even a timer closure that mentions the handle was not enough to keep
    it.
    - A `withLock` shape is safe: the handle is used again in `finally`.
    - A lock held for the life of the process, such as the loop-owner lock,
      must live on a long-lived object that later releases it.
    - Lock tests force GC (`Bun.gc(true)`) while the lock is held.

    The same spike verified the rest of this bullet list: same-process and
    cross-process exclusion, immediate `SQLITE_BUSY` with
    `busy_timeout = 0`, a bounded wait (`busy_timeout = 1000` gives up at
    ~1002 ms), release on SIGKILL even while a spawned child is still
    alive, and no two holders at once across 4 processes × 150
    acquisitions. It also verified the `data_version` behavior relied on in
    §5.3 item 4. **macOS has not been verified yet.** Task T0.1 of the
    implementation plan reruns the spike there.
  - `flock(2)` through FFI is an acceptable alternative, with one
    condition: the lock file must be opened close-on-exec. `flock` locks
    follow inherited descriptors, so a spawned `git` process could
    otherwise keep the lock held after the holder dies. SQLite's POSIX
    record locks are not inherited by children, so the SQLite option does
    not have this problem.
  - The holder's pid and start time go into a side file for
    `brain doctor`. That file is informational only and is never read to
    make a locking decision.
  - The pid-liveness rule and the 60 s rule both disappear. The dead-pid
    and 60 s cases in `test/unit/lock.test.ts` are rewritten as "the holder
    is SIGKILLed, and a waiter acquires". The API
    `withRepoWorktreeLock(runtimeDir, fn)` that fixture 3.12 calls does not
    change.
  - **One lock, one file.** A write transaction covers a whole database,
    so every lock gets its own empty SQLite file under `runtime/locks/`:

    | Lock | File |
    |---|---|
    | worktree (CR-1) | `worktree.sqlite` |
    | loop owner (CR-10) | `loop-owner.sqlite` |
    | turn, per session (CR-9) | `turn-<sessionId>.sqlite` |
    | knowledge, per session (CR-5) | `knowledge-<sessionId>.sqlite` |

    A data database (`queue`, `proposals`, `index`, `knowledge`) is never
    used as a lock. If it were, a minute-long knowledge run holding
    `knowledge.sqlite` would block every other process's marker writes past
    their `busy_timeout`.
  - **Lock order.** The fixed order is:

    loop owner → knowledge (session) → turn (session) → worktree

    A process that holds a lock acquires only locks later in this order:
    - The loop owner takes the worktree lock for each tick.
    - A backlog sweep holds the knowledge lock. It try-locks the turn lock
      only to read a range, and releases it before processing. It then
      takes the worktree lock, each time separately, in three places:
      `coord.listMutations()` and `coord.listProposals()` inside
      `buildPlannerInput` (`src/plan/context.ts:147–148`), `submit` /
      `submitProposal`, and `coord.reconcileIndex()`
      (`src/pipeline/knowledge.ts:177`). The order still holds. The cost is
      that a knowledge-lock holder can wait behind a long integrate in
      another process before it has anything to submit.
    - A turn writer holds only the turn lock. `replyToTurn` never calls
      the coordinator (`src/pipeline/chat.ts:105–113`), and the baseline
      write (§5.5 item 9) goes to a data database, not to a lock.
    - Nothing that holds the worktree lock acquires another lock.

    The only locks acquired by blocking wait are the loop-owner lock (only
    `brain watch` blocks on it, and it holds nothing else at that time) and
    the worktree lock (the last in the order). The turn lock uses a bounded
    wait and the knowledge lock uses try-lock. So there is no cycle, and no
    wait is unbounded except behind a live holder.
- **An accept completes after a crash.** `acceptProposal` writes
  ACCEPTED to `proposals.sqlite` (`src/core/coordinator.ts:286`) and then
  enqueues into `queue.sqlite` (`:297`). These are two databases with no
  shared transaction. A SIGKILL between the two writes leaves an ACCEPTED
  proposal with no mutation. `recover()` never looks at proposals, and
  accepting again returns `REPLAN` / `"STALE"`, so the user's decision is
  silently lost.

  The write order stays as it is. Enqueueing first would let a drain
  execute a mutation for a proposal the user can still reject.

  CR-1 instead reconciles each ACCEPTED proposal with its queue row, by the
  proposal's stable `mutationId`:
  - **No row**: rebuild the same mutation that `acceptProposal` builds
    (`:287–296`), with the same `mutationId`, `writes` and snapshot
    preconditions. Then enqueue it, execute it, and integrate it as
    `acceptProposal` does (`:303`). Without the integrate step the change
    would sit in `COMMITTED` until the next tick.
  - **Row in `REPLAN`**: mark the proposal STALE (ACCEPTED → STALE). This
    also covers a crash after enqueue but before execution, where a later
    drain sent the row to `REPLAN`.
  - **Any other state**: nothing to do.

  `enqueue` is already a no-op for an id that exists
  (`src/core/queue.ts:108`), so the step is idempotent. It runs under the
  lock as part of recovery (next bullet). The `REPLAN` → STALE check also
  runs in every `listProposals` staleness refresh. This adds a step to
  `docs/spec.md` §17.
- **Recovery runs continuously, not only at startup.** Today `recover()`
  runs once, when a process opens the repo (`src/cli.ts:212`).
  `drainQueued` executes only `QUEUED` rows (`src/core/coordinator.ts:179`),
  and rebuild considers only `COMMITTED` ones (`src/core/rebuild.ts:59`).
  So a `RUNNING` row left by another process that crashed, a dirty agent
  worktree, or an ACCEPTED proposal with no queue row would wait until some
  process restarts. A long-lived child might never do that, and Activity
  would show `RUNNING` forever.

  CR-1 makes continuous recovery safe. Execution holds the worktree lock
  from start to finish, so a process holding that lock knows that every
  `RUNNING` row it sees is dead. Therefore `drainQueued` begins, inside its
  single lock section, with the recovery steps:
  - §17 step 1: reset a dirty agent worktree.
  - Step 2: resolve `RUNNING` rows by their `Mutation-ID` trailer, then
    re-execute any that are not found.
  - Step 4: resolve `BLOCKED` rows to `REPLAN`.
  - The accept reconciliation above.

  In addition, a process that acquires the loop-owner lock (CR-10) runs a
  forced tick at once, as `brain watch` does at startup (`src/cli.ts:528`).
  This extends spec §17 and I-12 from "at startup" to "at startup and at
  the start of every drain", and it is part of CR-1's sign-off.

  The argument "every `RUNNING` row a lock holder sees is dead" assumes
  that every process executing mutations is a CR-1 binary. A pre-CR-1
  `brain` executes without the lock. The loop owner's per-drain reset could
  then wipe that binary's in-progress writes, or re-execute its row.
  **Mixed versions are therefore unsupported from CR-1 on**, not only from
  CR-5 on (§5.5 item 9). The same `PATH` version warning covers both.

  The "row in `REPLAN`" case of the accept reconciliation also covers an
  accepted mutation that reached `COMMITTED` but was invalidated at
  rebuild because `main` moved before integration. Today such a proposal
  stays ACCEPTED while its change is lost. Marking it STALE extends spec
  §34, which covers only "validation fails at execution". That extension is
  also part of CR-1's sign-off.
- `Queue.enqueue` uses an immediate transaction. Today it uses a deferred
  transaction, reads `MAX(seq)`, then inserts
  (`src/core/queue.ts:110–114`). In WAL mode, a second process can make
  that write fail when the transaction upgrades to a write lock.

Acceptance: start `brain watch --interval 50`, and at the same time run two
`brain chat --once` processes whose turns produce mutations (using the
scripted provider, CR-6). Afterwards there must be no `FAILED` or
`FAILED_INVALID_EXECUTION` rows, every `Mutation-ID` must appear exactly
once on `agent/repo`, and the agent worktree must be clean.

A second test: two processes accept and reject the same PENDING proposal
at the same time. Exactly one decision must win. A winning accept leaves
the proposal ACCEPTED, or STALE via REPLAN, and the reject fails with
`PROPOSAL_NOT_PENDING`. A winning reject leaves it REJECTED, and the accept
returns `REPLAN` / `"STALE"` without executing.

A third test: a holder is SIGKILLed while two waiters contend. At no point
may more than one process be inside the critical section; an `O_EXCL`
marker file created and removed inside the section checks this. Both
waiters must eventually run.

A fourth test: a crash is injected between the ACCEPTED write and the
enqueue. After restart there is exactly one commit carrying that
`Mutation-ID`, and the proposal is ACCEPTED. In a variant, the target
changes while the process is down. Then there is no commit, and the
proposal is STALE.

If a race or crash point is hard to reach otherwise, a delay or crash hook
used only in tests is acceptable.

**The app must not ship before CR-1.**

### 5.3 v0.1 process model (given CR-1)

1. The app spawns the bundled `brain rpc --stdio`, one child per repo.
2. **Loop ownership (CR-10).** A per-repo **loop-owner lock** decides who
   runs the loop: the Human Sync watcher plus `watchTick`
   (`src/cli/watch.ts:89`). It uses the CR-1 primitive, so the kernel
   releases it when its holder dies.
   - `brain watch` acquires it at startup and holds it for its lifetime.
     While another process holds it, `brain watch` waits and logs who
     holds it.
   - The child try-locks it at `initialize` and then every `intervalMs`
     until it succeeds. While it holds the lock, it runs the loop
     (`loopOwner: "self"`). Otherwise it runs no loop
     (`loopOwner: "other"`).
   - There is no hand-over. Whoever holds the lock runs the loop until it
     exits. If `brain watch` is SIGKILLed, the kernel frees the lock, and
     the child takes over within one interval.

   Two more changes follow. `brain watch` writes `watch.pid` only after it
   acquires the lock; today it writes the file right after opening the repo
   (`src/cli.ts:492–495`). `brain doctor` reports loop ownership from the
   lock's side file rather than from `watch.pid`
   (`src/config/doctor.ts:275–283`), so a waiting `brain watch` is not
   reported as "running".

   The `watch.pid` file (`src/config/doctor.ts:29`) is not used for this
   decision. It is removed only on a clean stop (`src/cli.ts:541`), so after
   a crash a reused pid would look like a live daemon. Holder details (kind
   and pid) go into an informational side file, the same way as for the
   CR-1 lock.
3. The child always runs the conversation pipeline for the app's own turns,
   so `knowledge.event` notifications have full detail whichever process
   owns the loop.
4. **Change detection.** Whoever owns the loop, the child polls a durable
   fingerprint every `intervalMs` and emits `repo.changed` naming the
   domains that moved (`protocol.md` §5). Commit ids alone are not enough:
   an external mutation that ends in `NOOP`, `REPLAN` or `FAILED` moves no
   head, and a proposal created while another one is decided leaves the
   pending count unchanged. The fingerprint therefore includes
   `PRAGMA data_version` for each state database, read on a **dedicated
   poll connection** that never writes. `data_version` changes whenever
   any *other* connection commits, including other connections in the
   same process. Because the child's own writes go through different
   connections, they register on the poll connection too, so no manual
   dirty-marking is needed.
5. When the app quits, `shutdown` drains in a fixed order (`protocol.md`
   §3):
   1. Stop accepting new requests.
   2. Let the in-flight loop tick finish.
   3. Let the underlying work of in-flight `conversation.send` and
      `capture.submit` requests finish, including cancelled ones, so each
      turn is stored whole and its turn lock is released.
   4. Let the knowledge run already in progress finish, and start no new
      ones.
   5. Close resources.

   Turns that are still unprocessed, including a turn whose reply was stored
   during step 3, stay in the durable backlog (§5.5). The next process that
   sweeps that session processes them. Shutdown does not wait for the
   backlog to empty, so quitting stays quick while the model is slow or
   unreachable.

   If the user forces quit mid-reply, the session keeps a user turn with no
   reply. `buildChatMessages` already tolerates this by merging consecutive
   same-role turns (`src/pipeline/chat.ts:80`). The turn becomes eligible as
   reply-less once its turn lock is released (§5.5 item 2).

   Edits made in external editors while nothing is running are committed by
   the next Human Sync. They are delayed, never lost.
6. Crash and relaunch rely on `recover()` being idempotent (I-7, I-12). The
   app adds no recovery logic of its own.

Upgrade path (not v0.1): `brain watch` serves the same protocol on
`$BRAIN_HOME/repos/<repo_id>/runtime/rpc.sock`, and the app connects to it
instead of spawning a child. This gives full engine notifications when the
loop belongs to the daemon. Only the transport changes.

### 5.4 Conversation sessions (CR-9)

CR-1 covers the knowledge repo, not the conversation store. The store has
two gaps of its own:

- **Turn ordering within a process.** `runTurn` appends the user turn,
  awaits the reply, then appends the assistant turn
  (`src/pipeline/session.ts:92–96`). Only knowledge runs are chained per
  session (`:60–75`). Two concurrent sends to one session can therefore
  store `user₁ user₂ assistant₂ assistant₁`.
- **Turn ids across processes.** `appendTurn` numbers turns from a
  per-instance cached count (`src/conversation/store.ts:59,120–125`). The
  app and a `brain chat --session <id>` in a terminal can hand out the same
  `turnId`, so one `conversation://<session>/<turn>` URI would name two
  turns. Grounding provenance depends on those URIs being unambiguous
  (I-16, I-18, `docs/spec.md` §27).

Required:

- A per-session, cross-process **turn lock**, released by the kernel like
  CR-1 (see the next bullet). It is held from appending the user turn to
  appending the assistant turn (or, for a capture, just the append).
  A second writer to the same session makes a **bounded wait** for the
  lock. The bound is a server constant of about 1 s, not a protocol
  guarantee. The contract is only this:
  - If the writer gets the lock within the bound, it proceeds. Its user
    turn is appended after the earlier turn's reply, so the two turns run
    one after the other, in order.
  - Otherwise it fails with `SESSION_BUSY`.

  Nothing promises that concurrent sends produce a `SESSION_BUSY`. A fast
  reply, the mock provider, or a second request that arrives just as the
  first finishes can release the lock within the bound, and then both
  requests succeed in sequence. The bound exists so that a backlog sweep,
  which holds the lock only while it reads a range (§5.5 item 2), doesn't
  surface as busy. Chat UIs already disable Send while a reply streams, and
  the CLI prints an error on `SESSION_BUSY`.
- Turn ids are allocated from the file under that lock, never from a
  cache. The count cache may stay only as a check against the file.
- The turn lock uses the same kernel-released primitive as CR-1. Writers
  acquire it with the bounded wait above, and sweeps use try-lock. It has
  no staleness rule, because the kernel releases a crashed holder's lock.
- Tests:
  - A holder keeps the lock longer than the bound, and the second writer
    gets `SESSION_BUSY`.
  - A holder releases within the bound, and the second writer proceeds.
    The session then reads `user₁ assistant₁ user₂ assistant₂`, with unique
    and increasing turn ids.
  - Both cases are also run with the second writer in another process.
- Ordering knowledge runs across processes is the job of the knowledge
  backlog (§5.5), not of the turn lock. The two locks are separate, so the
  user can send the next turn while knowledge runs for the previous one.

### 5.5 Knowledge backlog (contract for CR-5)

Today each turn's knowledge run is an in-memory promise, chained per
session inside one process (`src/pipeline/session.ts:60–75`). Its input is
whatever the session holds when the run starts (`store.getTurns`, `:100`).
Nothing durable records which turns have been processed, so a run lost to a
crash, a forced quit, or an offline provider never happens. CR-5 makes the
backlog durable, under this contract:

1. **Marker.** Each session has a durable `extractedThrough`: the id of the
   last user turn whose run is finished. See item 9 for sessions that
   existed before CR-5, which get a baseline and no replay. It lives under `BRAIN_HOME` in its
   own SQLite database, called `knowledge.sqlite` here (CR-5 settles the
   name), never in the knowledge repo (I-24). A session's backlog is its
   user turns after the marker. The backlog is derived from the marker and
   the session file, so there is no job table. A separate history table
   records finished runs for display (item 7).
2. **Eligibility and fixed range.** A user turn *t* may be processed only
   once it is **final**, meaning its range can no longer change. The turn
   lock (§5.4) is held from appending *t* until its reply is appended. So
   no turn can land between *t* and its reply, and once the lock is released
   no reply for *t* can appear. That makes *t* final in exactly two cases:
   - **A later turn exists** in the session. It is either *t*'s reply or,
     if the reply was never stored, the next user turn. The session file
     is append-only, so the range is already fixed, and no lock is needed.
   - **The processor holds the session's turn lock, and *t* is the last
     turn.** The order matters: the processor first try-locks the turn
     lock, and only while holding it checks that *t* is the last turn and
     reads the range, then releases the lock. If it checked first and
     locked second, a reply could land between the two steps, and *t*
     would be processed as reply-less even though a reply exists. When the
     check passes under the lock, *t* has no reply and never will.
     That happens for a capture, a reply that failed (`MODEL_ERROR`:
     `runTurn` appends the user turn and then throws,
     `src/pipeline/session.ts:92–95`), or a writer that crashed.

   Queries follow the same rule without writing anything. To tell
   `awaiting-reply` from `pending` for a last turn, a query try-locks the
   turn lock and releases it at once. If the try-lock fails, the turn is
   reported as `awaiting-reply`.

   In any other case (*t* is last and the turn lock is held), a reply is
   still being produced. *t* is not yet eligible. Processing is strictly
   ordered (item 3), so the sweep of this session stops at *t* and tries
   again at a later check.

   The range for a final *t* is the trailing extractor window (default 8,
   `src/pipeline/knowledge.ts:83`). It ends at *t*'s reply when the turn
   right after *t* is an assistant turn, and at *t* otherwise. Later turns
   are never included.

   **Behavior change:** a turn whose reply failed is now processed without
   a reply. Today its knowledge run never starts, because `runTurn` throws
   before creating it (`src/pipeline/session.ts:95–99`). A user turn is
   valid grounding with or without a reply (I-16).
3. **One processor per session, strict order.** A process works on a
   session's backlog only while holding that session's **knowledge lock**.
   This is the CR-1 primitive, in try-lock mode. The holder processes
   backlog turns strictly in order. A process that can't take the lock does
   nothing, because the holder will get to those turns. This replaces the
   in-memory chain and orders runs across processes.
4. **Outcome and advancement.** Each run ends in one of two outcomes:
   - **Deferred.** The extraction step failed with a retryable provider
     error, or no model is configured. Both adapters throw
     `ModelProviderError` with a `retryable` flag (`src/model/claude.ts:56`,
     `src/model/openrouter.ts:87,103`). Nothing from
     *t* reached the repo. The marker stays. The holder stops working on
     this session, releases the lock, and retries later with capped
     backoff.
   - **Completed.** Everything else: zero candidates, an extractor parse
     error, a refusal, or per-candidate planning or submit errors. The
     marker advances to *t*.

   Runs happen strictly in order under one lock, so the marker only ever
   advances over a contiguous prefix of finished turns. A later turn cannot
   finish while an earlier one is deferred.

   Today `processTurnForKnowledge` flattens errors into strings
   (`src/pipeline/knowledge.ts:111–114`). CR-5 therefore has to return a
   structured outcome. That is an additive change and leaves `types.ts`
   alone.
5. **No partial retry.** A turn is retried only when it was deferred as a
   whole, before anything reached the repo. Once extraction succeeds,
   per-candidate failures are surfaced (Activity, and `knowledge.event`
   `error`) but never retried. Re-planning the same candidate could
   produce a CREATE under a different slug, and `ABSENT(slug)` (I-1) would
   not catch that duplicate.
6. **Crash.** The kernel releases the knowledge lock, and the next holder
   resumes at the marker. Before a run submits its first mutation or
   proposal, the holder durably records "*t* has started writing". On
   resume:
   - If *t* crashed after that point, it is finished as `interrupted`,
     surfaced in Activity, and not re-run, which is consistent with item 5.
   - If *t* crashed before that point, it simply runs again.

   The result is at most once for anything that reaches the repo, and at
   least once for extraction.
7. **Durable, queryable state.** `knowledge.event` notifications are
   transient, and only the process that runs a turn sends them. Activity
   therefore reads backlog state from storage, never from remembered
   notifications:
   - **Per session:** marker, the in-flight turn and whether it has started
     writing, and the deferral (turn, reason, attempts, next attempt).
   - **Per finished run:** turn, outcome (`completed` or `interrupted`),
     time, and the one-line summary from `formatKnowledgeSummary`
     (`src/pipeline/knowledge.ts:216`). This includes runs that produced
     nothing ("Knowledge unchanged"), so a zero-candidate run finished by
     another process is still visible.

   The protocol exposes this state through `knowledge.backlog`,
   `knowledge.runs`, and a per-turn `knowledge` field on `TurnDTO`
   (`protocol.md` §4). A `knowledge` domain in `repo.changed` is driven by
   `data_version` on `knowledge.sqlite` (`protocol.md` §5). After a
   reconnect or relaunch, Activity is rebuilt from these queries.
8. **Who drives the backlog.**
   - The RPC server sweeps every session with a non-empty backlog every
     `intervalMs`, whatever `loopOwner` is. It already runs the pipeline
     for its own turns, so this is the same capability. Sessions it can't
     lock are skipped.
   - `brain chat` only ever sweeps its own session, with the same
     try-lock rule:
     - In the REPL, it sweeps after each reply, in the background. The
       sweep starts only after that turn's lock has been released.
     - Before it exits, it sweeps once more. If another process holds the
       session's knowledge lock, `chat` exits at once, and the holder
       processes the turns.
     - `--wait` (`src/cli.ts:708–709`) instead waits until the marker has
       passed its turn, whichever process ran it. It then prints that run's
       recorded summary (item 7). If the run was deferred, it prints the
       deferral reason and exits, leaving the turn in the backlog.
   - `brain watch` never runs knowledge. It has no model provider
     (`src/cli.ts:499–508`).

   Test: block a reply (the scripted provider holds it), and let another
   process sweep the backlog. *t* must not be processed while the reply is
   pending. Once the reply is stored, *t* is processed and its range
   includes the reply. In a variant, the reply fails. *t* is then processed
   without a reply after the turn lock is released.

   Consequence: a backlog in a session that no running process touches,
   such as a deferred `brain chat --once` run or a capture made just
   before the app quit, waits until the app runs again. Giving
   `brain watch` a model so that it can drive the backlog would be a
   separate sign-off item. This document does not assume it.
9. **Sessions from before CR-5: baseline, no replay.** Sessions created
   before CR-5 have no marker. Their turns were already processed by the
   old in-memory pipeline, or were lost when it was interrupted, and nothing
   records which. Treating "no marker" as "never processed" would re-extract
   the whole history on first start. That costs model calls, re-creates
   proposals, and can create duplicate notes under different slugs, which
   no precondition catches (item 5). So:
   - A new-version `createSession` writes the session's progress row, with
     an empty marker, **before** it creates the session file. Such a
     session starts from its first turn. If the process crashes between
     the two writes, the only leftover is a harmless orphan row. The
     reverse order could leave a new session without a row, and the next
     rule would then skip its turns.
   - A session file that has **no progress row** is a legacy session. Its
     baseline is written only while the session's **turn lock** is held,
     and by whichever comes first:
     - a writer about to append a turn (`conversation.send`,
       `capture.submit`, `brain chat --session`), which writes the baseline
       before appending;
     - a sweep, which try-locks the turn lock and skips the session this
       round if it can't get it.

     The baseline row sets the marker, and `baselineThrough`, to the
     session's last user turn at that moment. It is inserted with
     insert-if-absent, so the first writer wins. Because the lock is held,
     no turn can be appended between reading the last turn and writing the
     row. A new turn therefore always lands after the baseline and is
     processed. Only turns appended after the baseline are ever processed.

     Queries never write a baseline. For a session with no row,
     `knowledge.backlog` returns `extractedThrough: null`, with
     `baselineThrough` set to the id the baseline would get. Per turn,
     `TurnDTO.knowledge` reports every user turn as `before-backlog`.
   - Turns at or before `baselineThrough` that have no run record report
     `before-backlog` (`protocol.md` §7). They are never shown as
     `completed`, because nothing says they were.
   - Nothing in v0.1 moves a marker backwards. Re-processing history is a
     separate, explicit operation that would warn about duplicates. It is
     deferred (§14.6), and no path triggers it automatically.
   - **Mixed versions are unsupported after CR-5**, as they already are
     after CR-1 (§5.2). An older `brain` binary using the same
     `BRAIN_HOME` runs its own in-memory knowledge on turns it appends. The
     new backlog would then process those turns again. The app compares the
     `brain` found on `PATH` with its bundled version and warns, and
     `brain doctor` reports a mismatch.

   Acceptance: take an existing knowledge repo with sessions and start the
   new version for the first time. No knowledge run starts for any
   historical turn. Every legacy session's marker equals its last user
   turn, and those turns report `before-backlog`. A new turn sent to a
   legacy session is processed normally. This last case is tested both
   ways: with the first send arriving **before** any sweep has seen the
   session, and after. Test hooks control the sweep, so the outcome does
   not depend on timing.

## 6. A turn as the app sees it

`runTurn` resolves once the reply is stored. Knowledge maintenance is a
separate promise, chained per session (`src/pipeline/session.ts:99`). The
protocol mirrors this:

```
conversation.send ─► reply.delta* ─► result {turn, assistantTurn, contextNotes}
                                        (request closed)
      … later …   ─► knowledge.event {sessionId, turnId, event}*   (notifications)
                     ending with event.type = "done" (+ summary)
```

`event` is a `KnowledgeEvent` (`src/pipeline/knowledge.ts:57`), unchanged
except for the two additive variants CR-5 introduces, `deferred` and
`interrupted` (§5.5).
The one-line summary is produced by core (`formatKnowledgeSummary`,
`src/pipeline/knowledge.ts:216`), so the app never re-derives text such as
"Knowledge updated · 2 notes".

## 7. Proposal review

- `proposals.get` returns the `Proposal` (`src/core/types.ts:200`) and one
  diff per target, computed in core (CR-4). The before side is the snapshot
  blob (`targets[].blobHash`). The after side is `writes[].content`, where
  `null` means delete. `docs/spec.md` §33 mentions `proposedDiff`, but the
  `Proposal` type has no such field. The diff is therefore a core function,
  never a Swift computation.
- Accept calls `proposals.accept`. Core catches up with main and re-checks
  staleness against agent HEAD (`src/core/coordinator.ts:275`). If the
  result has `state: "REPLAN"`, core has already marked the proposal STALE.
  The app re-fetches it and says the note changed since the proposal was
  made (`protocol.md` §4).
- Reject calls `proposals.reject` with an optional note. Rejections persist
  and become negative evidence for the planner (I-20), and the UI may say
  so.
- Only proposal operations appear in the Inbox: ARCHIVE,
  RECONCILE_EVOLUTION, MERGE, DELETE, RENAME_SLUG
  (`src/core/types.ts:96`). The app never turns an automatic mutation into
  a proposal, or a proposal into an automatic mutation.

## 8. What the Knowledge Browser shows

The index projects `agent/repo` HEAD (I-23). The browser shows the same
view the planner reads (`docs/design.md` §15).

- Content comes from `notes.get`, which reads at agent HEAD. The user
  worktree file is never read, because it may have uncommitted edits.
- When `agentHead != mainHead`, the paths that differ carry a "pending
  integration" badge. This is normal while the user has uncommitted edits,
  because integration waits for them (I-10). The list of paths comes from
  one call, `repo.pendingIntegration` (`protocol.md` §4). It is refetched
  when `repo.changed` lists `"git"`, not fetched once per note.
- Backlinks and outlinks come from the index. A dangling link is shown as
  unresolved (I-22), and clicking it creates nothing.

## 9. Quick Capture

A global panel. The shortcut defaults to `⌥Space` and is configurable,
because launchers often claim that key. Saving stores one user turn and
returns. It produces no reply, and nothing on the save path calls a model,
the network, embeddings or Git.

`runTurn` always replies first, so capture needs a new pipeline entry point
(CR-5): append the user turn, return, and run knowledge maintenance later.
Offline capture relies on the durable knowledge backlog (§5.5). The
backlog's marker is the "extracted through turn N" tracking from `todo.md`
F3, so CR-5 implements that half of F3 rather than adding a second
mechanism.
Captured turns are ordinary user turns, so grounding and the low-content
rule (I-16) apply unchanged.

## 10. Credentials

The CLI keeps `~/.brain/config.toml` (mode 600). The app keeps keys in the
macOS Keychain and passes them in `initialize` (`protocol.md` §3). Core
builds its providers from a private environment. `createModelProvider(env)`
and `createEmbeddingProvider(env)` already accept one
(`src/model/index.ts:51,92`). That is enough for OpenRouter, whose key is
read from `env` (`src/model/index.ts:54`).

It is **not** enough for Anthropic. That path builds
`new ClaudeModelProvider({ model, effort })` (`src/model/index.ts:74`). Its
options carry no credentials (`src/model/claude.ts:47–53`), and it calls
`new Anthropic()` (`:102`), which reads `ANTHROPIC_API_KEY` from
`process.env` (`:17–18`). CR-11 therefore has `ClaudeModelProvider` accept
`apiKey`, `authToken` and `baseURL`, and has `createModelProvider` pass
them from `env`, as `src/config/doctor.ts:99–102` already does. The
`NO_MODEL` check must also run on the private env:
`hasModelCredentials(env)` takes it as a parameter (`src/cli.ts:549`).

Keys never go into `process.env`, because Git subprocesses inherit it
(`src/git/git.ts:42`). They are never written to
disk by the app, and they are redacted from every log line, including
relayed stderr. If Keychain has no key, the child falls back to
`config.toml` with the CLI's precedence (`protocol.md` §3). Changing the
provider, model or a key in Settings restarts the child: `shutdown`, spawn,
then `initialize`. The protocol has no reconfigure method.

The CLI currently projects `config.toml` onto `process.env`
(`src/cli.ts:994`), so Git subprocesses, including hooks in the user's
repo, inherit API keys today. The RPC entry point must not do the same.
Fixing the CLI itself is outside this document's scope, but it is worth a
follow-up.

## 11. Distribution

- Signed with Developer ID and notarized, without the App Sandbox. The
  engine spawns `git`, writes to `$BRAIN_HOME`, and works on a repo path the
  user chooses.
- The app bundles the `darwin-arm64` and `darwin-x64` binaries that
  `.github/workflows/release.yml` already builds, signed with the app.
  Bun-compiled binaries need hardened-runtime entitlements for JIT. The
  exact set must be verified on a real build, not copied from memory.
- **Git version (CR-7).** `brain doctor` requires Git ≥ 2.40
  (`src/config/doctor.ts:27`). Its own parser comment cites
  `2.39.5 (Apple Git-154)`, which is what Xcode Command Line Tools ship, so
  a stock Mac fails the check. The commit that introduced the floor
  (`9ab3836`) records no reason. Before choosing between lowering the
  floor, bundling Git, or requiring Homebrew Git, run the suite against
  2.39.x.

## 12. Degradation

This follows `docs/design.md` §18.

| What fails | Effect |
|---|---|
| The app | The user keeps the CLI, Markdown, Git, nvim and Obsidian. |
| The model provider | Replies fail visibly. Quick Capture still saves (CR-5). Browser, Search (with `hashing` embeddings), History and Proposal Inbox keep working. |
| The child process | The app relaunches it, and `recover()` restores the queue. |

## 13. Issues from the discarded native-notes draft

These issues were found in the discarded root-level `DESIGN.md`. All are
resolved by keeping the existing core.

| Issue | Resolved by |
|---|---|
| Authorship isolation | Two worktrees plus Human Sync (I-2, I-10–I-13), and no editor in the app |
| SQLite canonicality | Derived state under `BRAIN_HOME` (I-23–I-25); queue and proposals live in separate DBs (`src/core/types.ts:273`) |
| CREATE precondition | `{kind: "absent", slug}` (`src/core/types.ts:115`) |
| Write-set strictness | A declared path left byte-identical is tolerated (I-3, `src/core/executor.ts:268`) |
| Link namespace | Shared case-insensitive slug and alias namespace (I-21) |
| `updated` frontmatter | Not introduced; required keys stay `id created type status` (`docs/design.md` §9) |
| Read-set invalidation | Still a v0 non-goal (I-1); the client does not redefine it |
| Second lifecycle | No Swift state machine; `MutationState` (`src/core/types.ts:144`) and `ProposalStatus` (`:192`) are displayed as they are |

## 14. Open decisions

1. **Revert.** No `MutationType` covers it, and `docs/design.md` doesn't
   design it. v0.1 shows history and diffs only. Adding revert is a change
   to the core design, not an app feature.
2. **Cancellation.** The model adapters have no abort path (`src/model/`
   has no `AbortSignal`). In v0.1, `cancel` stops event delivery only; the
   turn still completes and is stored (`protocol.md` §3).
3. **Multi-repo.** v0.1 has one repo per window and one child per repo.
4. **Socket transport.** See §5.3, upgrade path.
5. **Capture session.** Captures could go to a dedicated capture session
   (per day or permanent) or to the active conversation. Today a session has
   no kind or metadata beyond its header (`src/conversation/store.ts:18`).
   A dedicated session would need a header field. Capturing into the
   active conversation would also hit `SESSION_BUSY` whenever a reply is
   streaming (§5.4), which argues for a dedicated session. This is decided
   together with CR-5.
6. **Re-processing history.** An explicit operation to move a session's
   marker backwards and re-extract, with a warning about duplicates
   (§5.5 item 9). It is not in v0.1.

## 15. Required core changes

These are TypeScript changes the app depends on. Items marked **sign-off**
change existing behavior or wording, so the owner must approve them before
implementation. `docs/design.md`, `docs/invariants.md`, `test/fixtures/**`
and `src/core/types.ts` are not edited by any item.

| ID | Change | Sign-off |
|---|---|---|
| CR-1 | Cross-process single writer (§5.2): the kernel-released lock primitive with one file per lock and a fixed lock order, the lock taken once per write path, compare-and-set proposal decisions, accept crash recovery, and continuous recovery at the start of every drain. | **Yes.** It replaces the primitive in `src/sync/lock.ts` and rewrites its unit tests. It adds a step to `docs/spec.md` §17 and runs §17's recovery at every drain, not only at startup, which also changes I-12's "on startup" wording. It extends §34 so that a proposal also becomes STALE when its accepted mutation is invalidated at rebuild. Mixed `brain` versions sharing a `BRAIN_HOME` become unsupported. I-11 could also gain the words "and mutation execution / recovery" for clarity. |
| CR-2 | Service layer extracted from `src/cli.ts`: the open sequence of `openRepo` plus command bodies. CLI and RPC both call it. `runDoctor` can reuse an open coordinator (`protocol.md` §3). The one visible CLI change: `brain status` reads its pending-proposal count without the lock, so the count is advisory, as in the protocol (`protocol.md` §5). The reject PENDING check (`src/cli.ts:440`) moves into core under CR-1 instead. | No, it is a pure refactor. |
| CR-3 | RPC adapter `brain rpc --stdio` in `src/rpc/`, implementing `protocol.md`. | No. |
| CR-4 | Diff and history functions: proposal diff, commit diff, `main` history with parsed trailers (`src/git/git.ts:231`), and the paths that differ between `main` and agent HEAD. | No. |
| CR-5 | Durable knowledge backlog (§5.5) and the capture entry point (append a user turn, with no reply). It replaces the in-memory chain (`src/pipeline/session.ts:60–75`) and fixes each run's input range. It implements F3's tracking half. Sessions from before CR-5 get a baseline with no replay (§5.5 item 9). Using the marker to show the extractor which turns are context only is a follow-up. | **Yes.** It changes how and when knowledge runs happen, and it makes running older `brain` binaries against the same `BRAIN_HOME` unsupported. The pipeline stages (`docs/spec.md` §36) stay the same. |
| CR-6 | Scripted model provider for deterministic RPC transcripts, selected with `BRAIN_MODEL_SCRIPT=<file>` and built on `MockModelProvider`. The existing mock makes no knowledge extraction (`src/cli.ts:555`). | No; it is test only. |
| CR-7 | Git version floor, decided from test results (§11). | **Yes.** It changes README and `brain doctor`. |
| CR-8 | Turn timestamps exposed at the store level (`TurnLine.at`, `src/conversation/store.ts:29`) without changing `ConversationTurn`. | No. |
| CR-9 | Per-session cross-process turn lock, using the CR-1 primitive, and on-disk turn id allocation (§5.4). | No. It restores the uniqueness that provenance URIs already assume. |
| CR-10 | Loop-owner lock (§5.3 item 2). `brain watch` holds it for its lifetime, and the RPC child runs its loop only while it holds it. `watch.pid` is written only after acquisition, and `brain doctor` reads the lock's side file. | **Yes.** `brain watch` now waits while another process owns the loop, instead of starting a second loop. |
| CR-11 | `ClaudeModelProvider` accepts credentials and a base URL from the passed env; `NO_MODEL` checks the private env (§10). | No. This is an additive option, and CLI behavior is unchanged. |

**Rejected alternative to CR-1.** A per-repo lease held for the whole life
of a process, where a second process fails with a "busy" error. It is
simpler, but it breaks the documented workflow of running `brain watch`,
or the `--install` login service, next to `brain chat`. It would also stop
the app from starting whenever that service is installed. Making it
acceptable would require every CLI command to become a client of the
daemon, which is the socket upgrade path, and that is too large to be a
prerequisite.

## 16. Non-goals for v0.1

Markdown editing or rich text, a Swift mutation engine, graph
visualization, revert, multi-device sync, a Mac App Store build, an HTTP
server, plugins, and everything in `docs/design.md` §19.
