# Brain RPC Protocol — v1

Status: Draft
Date: 2026-09-29
Server: `brain rpc --stdio` (RPC adapter, `src/rpc/`)
Client: BrainKit (Swift) in `apps/mac/` (`implementation-plan.md` §2)

This protocol exposes the existing service layer. It adds no semantics.
Every DTO in this document is either a type from `src/core/types.ts` (read
only for implementers, `src/core/types.ts:4`) or an RPC-only shape defined in
`src/rpc/dto.ts`, and each one cites its source. If this document and
the code disagree, the code and `docs/` win, and this document is the bug.

---

## 1. Transport

- The client spawns `brain rpc --stdio`. The environment is inherited, plus
  `BRAIN_HOME` if the app overrides it. Tests set `BRAIN_HOME` to a temp dir
  (I-25) and may set `BRAIN_MODEL_MOCK=1` or `BRAIN_MODEL_SCRIPT` (CR-6, `design.md` §15).
- **stdout carries protocol only**: one JSON object per line, UTF-8, `\n`
  terminated, never pretty-printed. The RPC adapter redirects
  `console.log` to stderr, so no library can corrupt the stream.
- **stderr carries human-readable log lines**, the same lines `brain watch`
  prints today. The client writes them to its log. It never parses them and
  never shows them raw.
- If stdin reaches EOF, the server treats it as `shutdown` (§3).
- There is no flow control. The client must read stdout continuously.

The protocol does not depend on stdio. A later `runtime/rpc.sock` transport
(`design.md` §5.3) carries exactly the same messages.

## 2. Framing

```jsonc
// client → server: request
{"id": "42", "method": "conversation.send", "params": {"sessionId": "01K…", "text": "…"}}

// server → client: zero or more events for that request, in order …
{"id": "42", "type": "reply.delta", "data": {"text": "Reversib"}}
// … then exactly one terminal message
{"id": "42", "type": "result", "data": { … }}
{"id": "42", "type": "error",  "error": {"code": "NO_MODEL", "message": "…", "data": { … }}}

// server → client: notification (no id)
{"type": "knowledge.event", "data": { … }}
```

- `id` is a client-chosen string, unique among in-flight requests.
- Events for one request keep their order. Notifications can arrive between
  events of different requests.
- Requests are handled concurrently. Within this server, coordinator
  operations run one at a time, in the order they are invoked
  (`src/core/coordinator.ts:109`). Across processes, CR-1 guarantees mutual
  exclusion only, not any order. The protocol guarantees no ordering
  between different requests. A `conversation.send` never calls the coordinator
  itself. Its knowledge run reaches the coordinator later, from a backlog
  sweep (`design.md` §5.5).
- **One turn per session at a time, across processes (CR-9,
  `design.md` §5.4).** A `conversation.send` or `capture.submit` that
  targets a session with a turn in flight makes a bounded wait for that
  session's turn lock. The bound is a server constant of about 1 s. If the
  request gets the lock within the bound, it proceeds after the earlier
  turn. Otherwise it fails with `SESSION_BUSY` (`data: {sessionId}`). This
  holds whether the turn in flight belongs to this server or to another
  process, such as `brain chat --session`. Turns are never reordered. The
  protocol does **not** promise that concurrent sends produce a
  `SESSION_BUSY`, because a fast reply can release the lock within the
  bound.
- Unknown `type` values and unknown fields must be ignored by the client.
  The server likewise ignores unknown request and `params` fields. A
  missing or `null` `params` is `{}`.
- A line the server cannot attribute to a request gets an `error` with
  **`"id": null`** and code `INVALID_PARAMS`: a line that is not JSON, a
  value that is not an object with a string `id`, or a request that reuses
  the `id` of a request still in flight (`data: {id}`; the stream of the
  request already using that id is left intact). The message never quotes
  the line. A request with a string `id` but a missing `method` or a
  non-object `params` gets `INVALID_PARAMS` with its own `id`.

## 3. Lifecycle

### Before `initialize`: first run

The child process can start before a repo has been chosen. Until
`initialize` succeeds, it accepts only these four requests. Anything else
returns `NOT_INITIALIZED`.

| Method | Params | Result | Source |
|---|---|---|---|
| `repo.init` | `{path}` | `{path, repoId, createdConfig, createdRepo, written, commitSha}` | `initKnowledgeRepo`, `src/markdown/repo.ts:169`; same data as `brain init` (`initRepo`, `src/commands/repo.ts:96`) |
| `doctor.run` | `{repoPath?, offline?, env?}` | `DoctorReport` | `runDoctor`, `src/config/doctor.ts:293`. `env` is merged as in `initialize` |
| `shutdown` | `{}` | `{}` | below |
| `cancel` | `{target}` | `{cancelled}` | below. This is useful for a first-run `doctor.run`: its live checks can take up to 15 s each (`src/config/doctor.ts:296`). Before T0.4, with `repoPath`, it also waited for the worktree lock |

None of these needs an initialized server, so first run stays inside one
protocol and one service layer. The alternative was one-shot
`brain init --json` / `brain doctor --json` calls. It was rejected because
the app would then have to parse CLI output as well as the protocol.

Since T0.4, `runDoctor` opens **no** coordinator, with or without
`repoPath`. It reads the heads with `git rev-parse` and the queue counts
read-only. So it never runs `ensureAgentWorktree` and never waits behind a
held worktree lock, and a hung holder is reported instead of blocking
doctor (`design.md` §5.2). `doctor.run` therefore needs no coordinator
before or after `initialize`. After `initialize`, `repoPath` defaults to
the initialized repo. The loop-ownership check reads the CR-10 lock and its
side file (`design.md` §5.3 item 2), and the live model check uses T0.9's
isolated credential mode (T1.3).

### `initialize`

```ts
params: {
  protocolVersion: 1;
  client: { name: string; version: string };
  repoPath: string;                       // user worktree (knowledge repo root)
  env?: Partial<Record<ProviderEnvKey, string>>;  // from Keychain; see below
  engine?: { intervalMs?: number };       // default 1000, same as `brain watch`
}
result: {
  protocolVersion: 1;
  brainVersion: string;                   // package.json "version"
  repoId: string;
  userWorktree: string;
  stateDir: string;                       // RepoPaths.stateDir, src/core/types.ts:273
  engine: EngineInfo;
}
interface EngineInfo {
  loopOwner: "self" | "other";            // who holds the loop-owner lock (design.md §5.3 item 2)
  owner?: { kind: "watch" | "rpc"; pid: number };  // informational, from the lock's side file; set when "other"
  intervalMs: number;
}
```

`ProviderEnvKey` is the allowlist of variables the providers read:
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
`OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (`src/model/index.ts:77,126`),
`BRAIN_MODEL_PROVIDER`, `BRAIN_MODEL`, `BRAIN_EFFORT`, `BRAIN_EMBEDDINGS`,
`BRAIN_EMBEDDING_MODEL`, `BRAIN_EMBEDDING_DIMS`. The three `ANTHROPIC_*`
keys reach the Anthropic provider since CR-11 (T0.9, `design.md` §10,
`src/model/index.ts:92–94`). Before T0.9 that provider read them from
`process.env`.

The server builds a private env and passes it to `createModelProvider(env)`
and `createEmbeddingProvider(env)` (`src/model/index.ts:65,114`):

```ts
applyUserConfigToEnv(loadUserConfig(), { ...process.env, ...params.env })
```

Precedence is the same as the CLI's: explicit values win, and `config.toml`
fills only the unset keys (`src/config/userConfig.ts:159`). Unlike the CLI
(`src/cli.ts:986`), the RPC entry point never projects `config.toml` or
`params.env` onto `process.env` (`design.md` §10). The `NO_MODEL` check
runs `hasModelCredentials` on this private env
(`src/commands/providers.ts:24`). Values
are redacted in every log line. `env` is fixed for the life of the server.
To change it, the client restarts the server.

`initialize` runs the same open sequence as `openRepo`
(`src/commands/repo.ts:63`), through the service layer (CR-2): `recover()`,
fast-forward the agent branch when nothing is pending, then reconcile the
index. Under CR-1 this sequence is safe while other `brain` processes are
running. The server then
try-locks the loop-owner lock (CR-10, `design.md` §5.3 item 2):

- If it gets the lock, `loopOwner` is `"self"`, and the server runs the
  Human Sync watcher and `watchTick` (`src/cli/watch.ts:96`) in process,
  the same loop as `brain watch` (`createWatchLoop`, `src/cli/watch.ts:171`),
  starting with a forced tick. The result reports this acquisition; no
  `engine.loopOwner` is sent for it.
- If not, `loopOwner` is `"other"`, and the server tries again every
  `intervalMs`. When it gets the lock, for example because `brain watch`
  exited or was killed, it emits `engine.loopOwner` and starts the loop
  with a forced tick.

In both cases the server polls for `repo.changed` (§5). The loop, the
polls and the later try-locks start once the `initialize` result is sent,
so no notification precedes it.

Errors: `PROTOCOL_MISMATCH`, `NOT_A_REPO`, `ALREADY_INITIALIZED` (for a
second `initialize`), `INTERNAL`.

### `shutdown`

`params: {}` → `result: {}`. The server drains in this order:

1. Stop accepting requests. Any request that arrives later gets
   `SHUTTING_DOWN`.
2. Stop scheduling loop ticks and polls, and wait for the tick in flight
   (as `brain watch` does, `src/cli.ts:502`).
3. Wait for the **underlying work** of every request to finish. A
   terminal message is not enough. A cancelled request has already sent
   `CANCELLED`, but its model call and turn storage continue (§3
   `cancel`). The server tracks each request's work separately from its
   message stream. When this step ends, every turn has been stored whole
   and every turn lock has been released.
4. Finish the knowledge run currently in progress in each session backlog
   this server holds (`design.md` §5.5), then release that session's
   knowledge lock. After step 1 the server starts no new backlog runs.
   Turns not yet processed stay in the durable backlog for the next
   process.
5. Close the coordinator, the index and the stores, release the
   loop-owner lock if held, send the `shutdown` result, and exit with
   code 0.

The server keeps sending events and notifications while it drains, so the
client can show progress. There is no server-side timeout. If the client
decides to stop waiting, it sends SIGKILL. The consequences are bounded
(`design.md` §5.3 item 5):
- A user turn may be left without a reply. Its knowledge run stays in the
  backlog (`design.md` §5.5).
- A run interrupted after it started writing is finished as `interrupted`,
  not re-run.
- On the next start, `recover()` restores the queue and completes any
  interrupted accept (`design.md` §5.2).

SIGTERM and stdin EOF start the same drain.

### `cancel`

`params: {target: string}`, `result: {cancelled: boolean}`. The target
request ends with `error {code: "CANCELLED"}` and gets no more events. **The
underlying work is not aborted**, because the model adapters have no abort
path (`src/model/` has no `AbortSignal`). For example, a cancelled
`conversation.send` still stores its user and assistant turns, and its
knowledge run still happens.

## 4. Methods

`→` gives the result `data` for each method. Names in `code` refer to §7.

### Repo and engine

| Method | Params | Result | Source |
|---|---|---|---|
| `repo.status` | `{}` | `RepoStatus` | `repoStatus` data, `src/commands/repo.ts:153` |
| `doctor.run` | `{repoPath?, offline?, env?}` | `DoctorReport` | `runDoctor`, `src/config/doctor.ts:293`. Same method as before `initialize`; `repoPath` defaults to the initialized repo |
| `repo.pendingIntegration` | `{}` | `{mainHead, agentHead, paths: string[]}` | new, CR-4: paths that differ between `main` and agent HEAD (`design.md` §8); `pendingIntegration`, `src/git/worktree.ts`. Takes no lock |
| `engine.status` | `{}` | `EngineInfo & {lastTick?: EngineTick}` | RPC |
| `engine.tick` | `{}` | `EngineTick` | `watchTick(…, {force: true})`, `src/cli/watch.ts:96`. Allowed whatever the loop owner (safe under CR-1). It runs after this server's tick in flight, never alongside it |

### Conversation

| Method | Params | Events | Result | Source |
|---|---|---|---|---|
| `conversation.list` | `{}` | — | `SessionSummary[]` | `src/conversation/store.ts:43` |
| `conversation.create` | `{}` | — | `{sessionId}` | `ConversationStore.createSession` |
| `conversation.get` | `{sessionId, limit?=100, beforeTurnId?}` | — | `{turns: TurnDTO[], hasMore: boolean}`. These are the newest `limit` turns before `beforeTurnId`, or before the end of the session, in session order. `hasMore` is true when older turns exist | `getStoredTurns` (CR-8), paged by `conversationTurns`, `src/commands/conversation.ts` |
| `conversation.send` | `{sessionId, text}` | `reply.delta {text}` | `{turn: TurnDTO, assistantTurn: TurnDTO, contextNotes: ContextNote[]}` | `runTurn`, `src/pipeline/session.ts:96` |
| `capture.submit` | `{text}` | — | `{sessionId, turn: TurnDTO}` | new, CR-5. The capture joins the current day's capture session, which is created on first use (`design.md` §14.5). `sessionId` in the result names it |
| `knowledge.backlog` | `{sessionId?}` | — | `SessionBacklog[]` (sessions whose backlog is not empty, or just the given session) | new, CR-5; `design.md` §5.5 item 7 |
| `knowledge.runs` | `{sessionId?, limit?=50, cursor?: string}` | — | `{runs: KnowledgeRun[], nextCursor?: string}`, newest first. `cursor` is an opaque value copied from a previous `nextCursor`, and `nextCursor` is absent on the last page | new, CR-5 |

`conversation.send` sends the `result` as soon as the reply is stored. The
turn then joins its session's durable knowledge backlog
(`design.md` §5.5). This server reports the run through `knowledge.event`
notifications keyed by `{sessionId, turnId}`, where `turnId` is the user
turn's id (§5), provided the run happens here. If another process holds
that session's knowledge lock, the run happens there, and this client
sees only `repo.changed`. A deferred run, for example while the provider
is unreachable, sends `knowledge.event` with `event.type = "deferred"` and
runs again later. The other option, keeping the request
open until knowledge finishes, is rejected. It would misrepresent the
pipeline (`src/pipeline/session.ts:112`) and block the UI's "request done"
state on background work.

`capture.submit` returns once the user turn is durably appended. It makes
no reply and no model call on the save path. Knowledge maintenance runs
later, and it is retried once a model is available, using the F3 marker
(CR-5). A capture joins the current day's capture session (`design.md` §14.5).
Its `knowledge.event` notifications are keyed by the captured turn, the
same way as for `conversation.send`.

Errors: `UNKNOWN_SESSION` (`src/pipeline/session.ts:98`), `SESSION_BUSY`
(§2), `NO_MODEL`
(`src/commands/providers.ts:53`), `MODEL_ERROR` (provider error message,
redacted).
`conversation.send` also returns `INVALID_PARAMS` for a missing or blank
`text`. `INVALID_PARAMS`, `UNKNOWN_SESSION`, `NO_MODEL` and `SESSION_BUSY`
leave the session unchanged. With `MODEL_ERROR` the user turn is already
stored, without a reply, as in `brain chat`.
`conversation.get` with a `beforeTurnId` that is not a turn of the session
returns `INVALID_PARAMS` (`data: {sessionId, beforeTurnId}`). Turns are
never removed, so a client that pages with ids it was given never gets this
error.

### Knowledge

| Method | Params | Result | Source |
|---|---|---|---|
| `notes.search` | `{query, limit?=10}` | `{hits: SearchHit[]}` | `hybridSearch` + `noteById`, `src/commands/notes.ts:40–43` |
| `notes.list` | `{offset?=0, limit?=200}` | `{notes: NoteRow[], total}` | `notesPage` + `noteCount`, `src/index/queries.ts:61,66` |
| `notes.get` | `{noteId}` | `NoteDetail` | index + `showFile(agentWorktree, agentHead, path)` |

`notes.get` always reads at agent HEAD (I-23, `design.md` §8). It never
reads the user worktree file. Error: `UNKNOWN_NOTE` (`data: {noteId}`), also
when the index briefly trails agent HEAD and the note's indexed path is not
there. The client refetches on the next `repo.changed`.

### Proposals and mutations

| Method | Params | Result | Source |
|---|---|---|---|
| `proposals.list` | `{status?: ProposalStatus}` | `ProposalSummary[]` | `listProposals` (refreshes staleness), `src/core/coordinator.ts:416` |
| `proposals.get` | `{proposalId}` | `{proposal: Proposal, diff: FileDiff[]}` | Refreshes staleness, then computes the diff (CR-4), both in one CR-1 lock section (`proposalDetail`, `src/core/coordinator.ts`). This makes the reachability argument below hold. `proposal` is the whole `Proposal`, with `writes`; `diff` has one entry per write, in `writes` order |
| `proposals.accept` | `{proposalId}` | `ExecutionResult` | `acceptProposal`, `src/core/coordinator.ts:438` |
| `proposals.reject` | `{proposalId, note?}` | `{proposalId, status: "REJECTED"}` | `rejectProposal`, `src/core/coordinator.ts:486`, with the compare-and-set of CR-1 (`design.md` §5.2). The PENDING check that was in `src/cli.ts:440` at `74d1445` moved into core (T0.5) |
| `mutations.list` | `{states?: MutationState[], limit?=100}` | `QueueRow[]` | `listMutations` (`seq` ascending, `src/core/queue.ts:165`). The service layer filters, reverses to newest first, and applies the limit. An empty `states` matches nothing |

When the proposal cannot apply, `proposals.accept` returns
`state: "REPLAN"`. If the proposal was already stale, `error` is `"STALE"`
(`src/core/coordinator.ts:447`). If it became stale during execution,
`error` is the executor's `"PRECONDITION_FAILED: …"`
(`src/core/executor.ts:252`) and the proposal is now `STALE`
(`src/core/coordinator.ts:467–469`). Either way this is a normal `result`, not
an `error` message. The client keys on `state === "REPLAN"`, re-fetches the
proposal, and shows that the note changed since the proposal was made.

Errors: `UNKNOWN_PROPOSAL` for `get`, `accept` and `reject`, and
`PROPOSAL_NOT_PENDING` for `reject` only. `accept` on a proposal that is
not PENDING (including ACCEPTED and REJECTED) returns the core result
unchanged: `REPLAN` / `"STALE"` (`src/core/coordinator.ts:446`).

Under CR-1, the PENDING check and the decision are one compare-and-set in
core, under the shared lock (`design.md` §5.2). Concurrent accept and
reject of one proposal from any two processes therefore end in exactly one
decision. The loser gets `PROPOSAL_NOT_PENDING` (reject) or `REPLAN` /
`"STALE"` (accept). Neither adapter checks status on its own.

### History

| Method | Params | Result | Source |
|---|---|---|---|
| `history.list` | `{path?, limit?=50, before?: sha}` | `HistoryEntry[]` | new, CR-4: `main`'s first-parent history + `parseTrailers`, `src/git/git.ts:256`; `historyList`, `src/commands/history.ts` |
| `history.diff` | `{sha, path?}` | `FileDiff[]` | new, CR-4: `historyDiff`, `src/commands/history.ts` |

`history.list` reads `main` (what the user owns). Pending agent commits
appear through `mutations.list` with state `COMMITTED`. There is no revert
method in v1 (`design.md` §14.1).

`history.list` returns the newest commits first and follows first parents,
so a merge made by hand is one entry. `path` keeps the commits that
changed that file, or a file under that directory, against their first
parent. `path` is relative to the repository root and literal (no pathspec
magic). `paths` still lists every file the commit changed. `before` keeps
only the commits older than that one, so a client pages with the last
`sha` of the previous page, and it must name a commit on `main`.
`history.diff` accepts any commit of the repository, also an agent commit
that is not integrated yet (`QueueRow.commitSha`). It compares the commit
with its first parent, or a root commit with the empty tree, and `path`
limits it to one file or directory. A `sha` or `before` is a hex object
name. Both methods read Git only and take no lock.

Errors: `INVALID_PARAMS` for a `sha` or `before` that names no commit,
`data: {sha}` or `{before}`, also for a `before` that is not on `main`; and
for a `path` that is absolute or contains `..`.

## 5. Notifications

| Type | Data | When |
|---|---|---|
| `knowledge.event` | `{sessionId, turnId, event: KnowledgeEvent, summary?: string}` | Every `KnowledgeEvent` of a run executed by this server. `summary` is set only on `event.type === "done"` and comes from `formatKnowledgeSummary` (`src/pipeline/knowledge.ts:216`). Every run ends with `done`, also one that failed inside; its failure is in `update.errors`. CR-5 adds two variants. `{type: "deferred", reason: string}` means the run will be retried (`design.md` §5.5 item 4). `{type: "interrupted"}` means a run is finished without being re-run after a crash (item 6). Both are additive (§8) |
| `repo.changed` | `RepoChanged` (below) | Some domain changed, whoever changed it: this process, `brain watch`, or a CLI command. The server checks every `intervalMs` whatever the loop owner. The client re-fetches the views of the listed domains |
| `proposals.changed` | `{}` | This process created or decided a proposal, or a `proposals.list` / `proposals.get` refresh marked one STALE. Precisely: one per proposal this process created, and one per operation of this process that decided or marked STALE any proposal. Those operations are an accept or a reject (including the staleness refresh each runs first), the refresh of `proposals.list`, `proposals.get` or a knowledge run's planning, and a drain's accept reconciliation. An operation that changed nothing sends none, for example an accept that returns `REPLAN` / `"STALE"` for a proposal already decided. Another process's changes are reported only by `repo.changed`. It is sent immediately, without waiting for the next check. The next `repo.changed` also lists `"proposals"` |
| `engine.loopOwner` | `EngineInfo` | This server acquired the loop-owner lock after `initialize` and started its loop (`design.md` §5.3 item 2). An acquisition at `initialize` is reported by its result instead (§3). It never loses the lock while running, so there is no reverse transition |
| `engine.tick` | `EngineTick` | Only when `loopOwner: "self"`: after ticks where `changed` is true, or where drained results include a state other than `INTEGRATED` |
| `engine.humanSync` | `{sha}` | Only when `loopOwner: "self"`: the loop's Human Sync watcher committed quiescent edits (`SyncResult.committed`, `src/core/types.ts:298`). Integration runs a Human Sync pass of its own first (`docs/spec.md` §15); a commit made there is not reported here, and shows as `repo.changed` with `"git"` and an `engine.tick` |
| `engine.error` | `{message}` | The loop caught an error (`onError` of `createWatchLoop`, `src/cli/watch.ts:200`; `brain watch` logs the same error). Redacted. Informational only |

```ts
interface RepoChanged {
  domains: ("git" | "index" | "queue" | "proposals" | "conversations" | "knowledge")[];  // non-empty
  mainHead: string; agentHead: string; indexedCommit: string | null;
  pendingProposals: number;          // advisory: counted on the poll connection, without a staleness refresh
}
```

`proposals.list` and `proposals.get` write STALE marks, so they take the
CR-1 lock and can wait behind a long execute or integrate in any process.
The client shows a loading state while they wait. The `pendingProposals`
counts in `repo.changed` and `repo.status` are read without the lock, so
polling and the status view never stall. `brain status` uses the same
advisory count (CR-2). They can briefly include a
proposal that the next refresh marks STALE.

Each check compares a fingerprint with the previous one. A domain is
listed when its component differs. The components are:

| Domain | Fingerprint component |
|---|---|
| `git` | `mainHead`, `agentHead` |
| `index` | `indexedCommit` and `PRAGMA data_version` on `index.sqlite`. An external `brain index` or watcher can add embeddings at the same commit, which changes search results without moving `indexedCommit` |
| `queue` | `PRAGMA data_version` on the server's poll connection to `queue.sqlite` (see below). This catches external `NOOP`, `REPLAN`, `BLOCKED` and `FAILED` transitions, which move no head |
| `proposals` | `PRAGMA data_version` on `proposals.sqlite`. This catches a create and a decision between two checks that leave the pending count unchanged |
| `conversations` | The set of `*.jsonl` session files and their sizes under `conversationsDir`. The cost is O(sessions) `stat` calls per check, acceptable for v0.1; file-system events can replace it later |
| `knowledge` | `PRAGMA data_version` on `knowledge.sqlite` (`design.md` §5.5 item 1). Catches marker advances, deferrals and finished runs made by any process, including zero-candidate runs that touch no other domain |

Every `data_version` is read on a **dedicated poll connection** for each
database. The poll connection never writes. SQLite documents that
`data_version` changes whenever any *other* connection commits, including
connections in the same process. All of this server's own writes go through
other connections, so they register too, and no manual dirty-marking is
needed.

`data_version` is also local to a connection
([SQLite](https://www.sqlite.org/pragma.html#pragma_data_version)). The
server takes a baseline when it opens each connection and again whenever
it reopens one. The fingerprint is never persisted, never sent, and never
used as a revision or replay cursor. It only answers "did something change
since my last check". After `initialize`, including after a child
relaunch, the client re-fetches every view it shows instead of assuming
continuity.

With `loopOwner: "other"`, integrations and Human Sync commits made by the
loop owner are visible only through `repo.changed`, without per-mutation
detail. Getting full fidelity is the reason for the socket upgrade path
(`design.md` §5.3).

## 6. Errors

`error: {code, message, data?}`. Codes are stable strings. `message` is
English, meant for logs, and never contains secrets. The client maps codes
to its own user-facing text.

`PROTOCOL_MISMATCH` · `NOT_INITIALIZED` · `ALREADY_INITIALIZED` · `NOT_A_REPO` ·
`INVALID_PARAMS` · `UNKNOWN_METHOD` · `UNKNOWN_SESSION` · `UNKNOWN_NOTE` ·
`UNKNOWN_PROPOSAL` · `PROPOSAL_NOT_PENDING` · `SESSION_BUSY` · `NO_MODEL` ·
`MODEL_ERROR` · `CANCELLED` · `SHUTTING_DOWN` · `INTERNAL`

Programmer errors (`TypeError` and similar,
`src/pipeline/knowledge.ts:97`) become `INTERNAL`. The server keeps
running unless the coordinator itself failed. In that case it sends
`engine.error` and exits non-zero, and the client relaunches it (`recover()`
restores state).

## 7. DTOs

Rules:

- Field names and enum strings are exactly those in the cited source. The
  Swift decoder gives every enum an `unknown(String)` case.
- IDs are opaque strings: `mut_<ULID>`, `prop_<ULID>`
  (`src/core/ids.ts:77`), session ULIDs, zero-padded turn ids
  (`src/conversation/store.ts:70`). Clients never parse them.
- Timestamps are ISO-8601 strings as stored. Frontmatter `created` is
  `YYYY-MM-DD` (`src/core/types.ts:46`).
- SHAs are full hex. The client shortens them for display.

### Enums (from `src/core/types.ts`)

| Enum | Values | Line |
|---|---|---|
| `NoteType` | `idea decision hypothesis question observation reference` | 12 |
| `NoteStatus` | `active tentative superseded resolved archived` | 20 |
| `AutomaticMutationType` | `CREATE ENRICH LINK ADD_ALIAS ADDITIVE_EVOLVE` | 89 |
| `ProposalMutationType` | `ARCHIVE RECONCILE_EVOLUTION MERGE DELETE RENAME_SLUG` | 96 |
| `MutationState` | `QUEUED RUNNING COMMITTED INTEGRATED NOOP REPLAN BLOCKED FAILED_INVALID_EXECUTION FAILED` | 144 |
| `ProposalStatus` | `PENDING ACCEPTED REJECTED STALE` | 192 |
| `TurnRole` | `user assistant` | 219 |
| `CommitTrailers.actor` | `agent human-sync human` (a missing trailer parses as `human`, `src/git/git.ts:275–276`) | 184 |
| `IntegrationResult.status` | `integrated refused-dirty nothing-to-integrate rebuilt-and-integrated` | 305 |
| `CheckStatus` | `ok fail warn skip info` (`src/config/doctor.ts:51`) | — |

Display guidance, which is not semantics: `NOOP` means "nothing to change"
and is never shown as a failure (I-3). `REPLAN` means "outdated, will be
re-planned". `BLOCKED` means "waiting on an outdated change".

### Core types sent unchanged

- `ExecutionResult`: `src/core/types.ts:172`
- `QueueRow`: `src/core/types.ts:155`
- `TargetPrecondition`: `src/core/types.ts:113`
- `Proposal`: `src/core/types.ts:200`. `ProposalSummary` is the same type
  without `writes`.
- `IntegrationResult`: `src/core/types.ts:304`
- `KnowledgeEvent`, `KnowledgeUpdate`, `KnowledgeMutationReport`,
  `KnowledgeProposalReport`: `src/pipeline/knowledge.ts:33–63`
- `ExtractionCandidate`, carried by the `planned` and `error` knowledge
  events: `src/core/types.ts:234`
- `ContextNote`: `src/pipeline/chat.ts:21`
- `SessionSummary`: `src/conversation/store.ts:43`
- `NoteRow`: `src/index/queries.ts:11`
- `Backlink`, `Outlink`: `src/index/backlinks.ts:7,13`
- `DoctorReport`, `DoctorCheck`: `src/config/doctor.ts:53,61`

### RPC-only shapes (`src/rpc/dto.ts`)

```ts
// ConversationTurn (src/core/types.ts:221) plus the timestamp the store already
// writes (TurnLine.at, src/conversation/store.ts:34). types.ts is not changed.
interface TurnDTO {
  sessionId: string; turnId: string; role: TurnRole; text: string; at: string;
  knowledge?: KnowledgeTurnState;    // user turns only; derived by core (design.md §5.5)
}

// Status of one user turn in its session's knowledge backlog.
type KnowledgeTurnState =
  | "before-backlog"   // at or before the session's baseline, no run record (§5.5 item 9)
  | "awaiting-reply"   // not final yet: its turn lock is held (§5.5 item 2)
  | "pending"          // final, after the marker, not started
  | "running"          // a knowledge-lock holder is running it now; takes precedence over "deferred" during a retry
  | "deferred"         // the earliest backlog turn; its last run was deferred and no process is running it now (item 4)
  | "completed" | "interrupted";   // finished (items 4, 6)

// design.md §5.5 items 1, 4, 6, 7
interface SessionBacklog {
  sessionId: string;
  extractedThrough: string | null;   // turn id; null before the first run
  baselineThrough?: string;          // set for sessions created before CR-5 (§5.5 item 9)
  pendingTurnIds: string[];          // user turns after max(extractedThrough, baselineThrough), in order;
                                     // [] for a legacy session that has no row yet
  inFlight?: { turnId: string; startedWriting: boolean };  // a holder is running this turn now
  deferred?: { turnId: string; reason: string; attempts: number; nextAttemptAt: string };
                                     // last outcome for the earliest pending turn was "deferred";
                                     // it stays set during a retry (inFlight then names the same turn)
                                     // and is cleared when that turn finishes
}

interface KnowledgeRun {
  sessionId: string; turnId: string;
  outcome: "completed" | "interrupted";
  finishedAt: string;
  summary: string;                   // formatKnowledgeSummary output, also for runs that changed nothing
  errors: string[];                  // KnowledgeUpdate.errors, src/pipeline/knowledge.ts:54
}

// RepoStatus, src/commands/repo.ts:119 (returned by repoStatus)
interface RepoStatus {
  repo: string; repoId: string; stateDir: string;
  mainHead: string; agentHead: string; indexedCommit: string | null;
  queue: Record<MutationState, number>; pendingProposals: number;
}

// hybridSearch hit + index row, src/commands/notes.ts:41–43; HybridSignals src/retrieval/hybrid.ts:38
interface SearchHit { noteId: string; score: number; title: string; path: string;
  signals: { lexical?: number; semantic?: number; graph?: number } }

interface NoteDetail {
  note: NoteRow;
  aliases: string[];                 // aliasesOfNote, src/index/queries.ts:71
  raw: string;                       // file at agent HEAD
  atCommit: string;                  // agent HEAD sha used for `raw`
  backlinks: Backlink[];
  outlinks: Outlink[];
  pendingIntegration: boolean;       // path changed between main and agent HEAD
}

// watchTick result, src/cli/watch.ts:80
interface EngineTick { drained: ExecutionResult[]; integration: IntegrationResult;
  changed: boolean; embedded: number }

// Computed in core (CR-4). Swift renders it and never computes it.
interface FileDiff {
  path: string;
  change: "added" | "modified" | "deleted";
  unified: string | null;            // unified diff, 3 lines of context; null only with beforeUnavailable
  additions: number; deletions: number;
  beforeUnavailable?: true;          // snapshot blob unreachable (see below)
}

// One commit on main. Trailers per docs/spec.md §54, parsed by parseTrailers.
interface HistoryEntry {
  sha: string; committedAt: string; subject: string;  // committedAt: committer date, UTC, as toISOString()
  actor: "agent" | "human-sync" | "human";            // no Actor trailer (a user's own git revert): "human"
  mutationId?: string; mutationType?: MutationType; replans?: string;
  paths: string[];                                     // changed against the first parent
}
```

For proposals, `FileDiff` compares the snapshot blob (`targets[].blobHash`)
with `writes[].content`. A `null` content produces `change: "deleted"`.
A write whose path has no target is `"added"`. A write whose content
equals its snapshot is still listed, as `"modified"` with `unified: ""`.
For history it compares `sha^` with `sha`.

`unified` has one format for proposals and commits: `--- a/<path>` and
`+++ b/<path>` (`/dev/null` for an absent side), then the hunks, each
headed by a bare `@@ -l,s +l,s @@` line. There is no `diff --git` or
`index` line. `additions` and `deletions` count the hunks' `+` and `-`
lines. Identical sides and an empty file added or deleted give
`unified: ""`. A binary file gives the one line
`Binary files a/<path> and b/<path> differ`. Both have zero counts.

The snapshot blob of an old, non-PENDING proposal can become unreachable,
for example after a rebuild followed by `git gc`. In that case the
`FileDiff` carries `unified: null`, zero counts and `beforeUnavailable: true`,
and the client shows the after content only. So the full shape is
`unified: string | null` plus an optional `beforeUnavailable?: true`.
PENDING proposals never hit this case, because a PENDING proposal's
snapshot is by definition still the blob at agent HEAD (I-19).

## 8. Versioning

`protocolVersion` is an integer. Additive changes (new methods, new
optional fields, new notification types, new enum values) do not bump it.
Clients must tolerate all of them. Removing or renaming something, or
changing what an existing field means, bumps it. The server supports
exactly one version. The app bundles its own `brain`, so the two always
ship together.

## 9. Conformance

This contract is enforced the same way `test/fixtures/` enforces the engine.

- `test/rpc/transcripts/*.jsonl`: recorded sessions.
  - The first line is a header,
    `{"asserts": {"notifications": [<type>, …]}}`, listing the notification
    types the transcript asserts. Two optional header fields are for the Bun
    harness only (`test/rpc/harness/transcript.ts`), and the Swift replay
    ignores them: `tmp`, the temp root as recorded, which the harness maps to
    the run's own temp root wherever it occurs, so recorded paths stay
    concrete; and `modelScript`, a model script for the server (CR-6).
  - Every other line is one of these:
    - a message, `{"dir": "c2s" | "s2c", "msg": {…}, "match"?: {…}}`;
    - an out-of-band test step, `{"dir": "test", "step": {…}}`. A step is,
      for example, spawning or killing another `brain` process,
      restarting the server under test, or releasing a test hook.

    The Bun harness performs steps. The Swift replay skips them.
  - `msg` is always the concrete message as recorded, so the Swift replay
    decodes it with the real types.
  - Matchers never appear inside `msg`. They live in the optional `match`
    field, which maps a JSON Pointer inside `msg` to a matcher, and only
    the Bun harness applies them. The matchers are:
    - `"<ulid>"`, `"<sha>"`, `"<iso>"`: a value of that form;
    - `"<id:PREFIX>"`, such as `"<id:mut>"` or `"<id:prop>"`: a prefixed
      id `PREFIX_<ULID>` (§7), with exactly that prefix;
    - `"<any>"`: any value;
    - `{"$contains": [x, …]}`: the array holds every listed element, and
      may hold others.

    Without a matcher, a value matches exactly. A `<ulid>`, `<id:PREFIX>`
    or `<sha>` match binds the recorded value to the actual one, and the
    Bun harness rewrites the recorded value to the actual one in every
    later line, so a later request can carry an id from an earlier result.
  - `repo.changed.domains` always gets a `$contains` matcher, because one
    poll can catch several domains, and new domains are additive (§8).
  - Server messages match as subsets: extra fields are ignored (§2).
  - Messages of one request match in order. Different requests may
    interleave in any order (§2).
  - Notifications match as an unordered multiset within each window. A
    window runs between consecutive client messages or steps, and the
    last window runs to the end of the transcript.
  - The harness sends the next client message, or performs the next step,
    only after every earlier `s2c` line, including the window's expected
    notifications, has matched. The last window ends when the server exits
    after `shutdown`, or at a fixed deadline otherwise.
  - Notification types not listed in the header are ignored.
  - The polling types, `repo.changed` and `engine.tick`, match "at least
    once" rather than an exact count. A window that expects none of them
    accepts any number.
- Recorded with `BRAIN_HOME` set to a temp dir and the scripted model
  provider (CR-6), so knowledge runs produce real mutations and
  proposals deterministically.
- `bun test` replays each transcript against `brain rpc --stdio`. The Swift
  test target replays the `s2c` side against BrainKit's decoder and state
  reducers. A transcript change that breaks either side fails CI.
- Minimum set:
  - First run: `repo.init`, then `doctor.run`, then `initialize`. Any other
    method before `initialize` returns `NOT_INITIALIZED`.
  - Handshake without a daemon (`loopOwner: "self"`), and with a live
    `brain watch` (`loopOwner: "other"`). In the with-daemon case, a step
    then edits a note in the user worktree, the daemon's Human Sync
    commits it, and a `repo.changed` listing `"git"` follows. An idle
    daemon tick writes nothing, so without such a step no `repo.changed`
    is guaranteed.
  - `brain watch` is SIGKILLed while the server has `loopOwner: "other"`.
    Within one interval an `engine.loopOwner` with `"self"` follows. A
    stale `watch.pid` naming a reused pid does not change the result.
  - A second `initialize` returns `ALREADY_INITIALIZED`.
  - `conversation.send` with streaming, followed by `knowledge.event`
    ending in `done` with a `summary`.
  - Capture while the provider fails.
  - Proposal accept, accept of a stale proposal (`REPLAN`), and reject.
  - A `NOOP` mutation reported as success.
  - Shutdown while a `conversation.send` is still awaiting its reply. The
    send's `result` arrives and the assistant turn is stored. Then the
    `shutdown` result arrives, and no knowledge run starts for that turn.
    After a restart, a sweep processes the turn from the backlog, and the
    run's range includes the reply.
  - Backlog eligibility (`design.md` §5.5 item 2): a reply held open by the
    scripted provider while another process sweeps. The turn is processed
    only after its reply is stored.
  - A zero-candidate run finished by another process: a `repo.changed`
    listing `"knowledge"` follows, and `knowledge.runs` returns the run
    with its summary.
  - Shutdown with a knowledge run in flight.
  - Turn lock held longer than the bound. The scripted provider holds the
    first reply open, and a second `conversation.send` to the same session
    gets `SESSION_BUSY`. The same test is repeated with the second writer
    being `brain chat --session` in another process.
  - Turn lock released within the bound. The first reply returns at once,
    and the second send proceeds after it. The session reads
    `user₁ assistant₁ user₂ assistant₂`, with unique, increasing turn ids.
  - First start on an existing repo with sessions (`design.md` §5.5
    item 9). No historical turn is processed, and those turns report
    `before-backlog`. A `conversation.send` to a legacy session before any
    sweep has seen it: the new turn is processed. Sweeps are held back by a
    test hook, so the result does not depend on timing.
  - Eligibility lock ordering: the reply is stored between the sweep's
    listing of the session and its try-lock. The turn is processed with
    its reply in range, never as reply-less.
  - A concurrent accept and reject of one proposal from two processes
    (`design.md` §5.2).
  - An external `brain` process drives a mutation to `NOOP`: a
    `repo.changed` listing `"queue"` follows.
  - An external `brain index` adds embeddings at an unchanged HEAD: a
    `repo.changed` listing `"index"` follows.
  - A cancelled `conversation.send` followed at once by `shutdown`: the
    `shutdown` result arrives only after the assistant turn is stored.
  - Backlog order: turn 2 is deferred while turn 3 is available. Turn 3
    does not run, and the marker stays at turn 1 until turn 2 finishes.
  - The CR-1 concurrency scenario (`design.md` §5.2) with the RPC server
    as one of the writers.
