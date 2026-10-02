# Brain for Mac — Mac-side Handoff

Status: Living checklist. It is started now and updated as core work lands.
Owner: the repo owner, working on a Mac.
Companions: `design.md`, `protocol.md`, `implementation-plan.md`.

The core work (M0 and M1, plus M2 once CR-5 is signed off) is done on Linux
by agents. Everything below needs macOS with Xcode, so it is done on the
owner's Mac. This file lists that work in order, with what each step needs
from the core. "Ready" means the core dependency has landed on
`impl/mac-m0`.

---

## 0. Before you start

- [x] **macOS CI result (T0.1).** Done 2026-10-02: `bun:sqlite` uses the
      system SQLite (3.51.0, Apple build), and every lock-relevant check
      passed. See `design.md` §5.2. The C3b log line in the `test-macos`
      job shows why Apple's SQLite left no hot journal, which helps only
      if hot-journal recovery ever matters on macOS.
- [ ] **Run the suite on your Mac once:** `bun install && bunx tsc --noEmit
      && bun test`. This also covers Apple Git (`git --version` should say
      `2.39.5 (Apple Git-154)` or newer; the floor is 2.39 after T0.10b).
- [ ] An Apple Developer account with a **Developer ID Application**
      certificate, for signing and notarization (design §11). Not needed
      for a local, unsigned alpha.

## 1. First alpha (personal use, unsigned)

Tasks from `implementation-plan.md` M3. Each one says which core task it
waits for.

| Task | What | Waits for (core) | Ready |
|---|---|---|---|
| T3.1 | Xcode project in `apps/mac/`. Bundle the `darwin-arm64` / `darwin-x64` binaries from `bun run build:all`. Signing and notarization can wait for §2 | T1.3 (`brain rpc --stdio`) | **yes** |
| T3.2 | BrainKit: spawn the child, JSONL codec, request correlation, notification stream, `Codable` DTOs with `unknown(String)` enum cases, `UNKNOWN_METHOD` treated as "feature absent". Replay `test/rpc/transcripts/*.jsonl` in the Swift tests: decode `msg` only, and skip `test` lines (protocol §9) | T1.3 | **yes** |
| T3.3 | First run and Settings: repo picker, `repo.init`, `doctor.run`, keys in Keychain passed as `initialize.env`, restart the child when settings change, warn when the `brain` on `PATH` differs from the bundled one | T1.3, T0.9 | **yes** |
| T3.4 | Conversation: sessions, streaming `reply.delta`, `SESSION_BUSY` handling. Per-turn knowledge chips appear only after T2.5 | T1.5 | **yes** |
| T3.6 | Proposal Inbox: diff rendering (`FileDiff`, including `beforeUnavailable`), accept / reject, the `REPLAN` → "note changed" experience | T1.6, T1.8 | **yes** |
| T3.7 | Knowledge Browser and Search: `notes.*`, pending-integration badges, "Open in external editor" | T1.4, T1.8 | **yes** |
| T3.5 | Activity and notifications. The backlog views appear only after T2.5 | T1.7 | **yes** |
| T3.8 | History and diff views | T1.8 | **yes** |
| T3.9 | Quick Capture panel and menu bar. The menu bar part (status, pending proposals, open app) needs only `repo.status` and `engine.status`, so it can ship in the first version. Only the capture panel waits for T2.4 | menu bar: T1.7; capture: T2.4 (needs CR-5) | menu bar: **yes**; capture: no |

**First version (owner decision, 2026-10-02):** T3.1–T3.8 plus the menu
bar part of T3.9, without Quick Capture. Quick Capture (T3.9) needs CR-5 and M2, which stay deferred
because Quick Capture is not core. The minimum useful alpha is T3.1–T3.4,
T3.6 and T3.7.

## 2. Signed release

- [ ] Verify the hardened-runtime entitlements the Bun-compiled binary
      needs (JIT) on a real signed build. Don't copy them from memory
      (design §11).
- [ ] Sign the app and the bundled `brain` binaries with Developer ID;
      notarize in CI (T3.1).
- [ ] M4: T4.1 resilience, T4.2 offline, T4.3 end-to-end acceptance,
      T4.4 performance and macOS conventions, T4.5 release.

## 3. Notes collected during core work

- The app passes keys in `initialize.env`. The server builds providers in
  T0.9's isolated mode, so Keychain keys never reach `process.env` or Git
  subprocesses (design §10).
- `brain watch`, when installed as a login service, owns the loop. The app
  then reports `loopOwner: "other"` and polls (design §5.3). Both can run
  at the same time.
- BrainKit must decode a message's `id` as an optional string. A line the
  server can't attribute to a request gets an error with `"id": null`
  (protocol §2; transcript `test/rpc/transcripts/framing.jsonl`).
- Decoding notes from T1.4:
  - `Outlink.targetNoteId` is `null` for a dangling link.
  - `RepoStatus.queue` always has all nine `MutationState` keys.
  - To page back through a conversation, call `conversation.get` with
    `beforeTurnId = turns[0].turnId` until `hasMore` is false.
  - `notes.get` can briefly return `UNKNOWN_NOTE` while the index catches
    up. Refetch on the next `repo.changed`.
- Transcript headers may carry `tmp` and `modelScript`, which are Bun-only.
  The Swift replay ignores them and skips `test` lines (protocol §9).
- Decoding notes from T1.6:
  - `proposals.accept` on a proposal that is no longer PENDING (or whose
    note changed) returns a normal result `{state: "REPLAN", error: "STALE"}`,
    not an error. Show it as "the note changed; this proposal is out of date".
  - `proposals.reject` on one that is no longer PENDING fails with
    `PROPOSAL_NOT_PENDING`, whose `data.status` says what won.
  - `proposals.changed` carries no payload and reports only this process's
    changes. Refetch `proposals.list` on it, and on a `repo.changed` that
    lists `"proposals"`.
  - Send `note` only when it is non-empty; `""` is `INVALID_PARAMS`.
- Decoding notes from T1.7:
  - `initialize` returns `engine.loopOwner` `"self"` when the app got the
    loop, and no `engine.loopOwner` notification follows for that. One
    arrives only when the app takes over later, for example after
    `brain watch` exits.
  - `EngineInfo.owner` is present only when the lock's holder is a `watch`
    or `rpc` process; decode it as optional.
  - Right after `initialize`, expect a `repo.changed` with `"index"`: the
    first tick embeds whatever is stale.
  - `engine.humanSync` reports only the watcher's commits. An edit
    committed by integration's own sync pass shows as `repo.changed` with
    `"git"`. Refresh views on `repo.changed`, not on `engine.humanSync`.
- Decoding notes from T1.8:
  - `FileDiff.unified` starts with `--- a/<path>` / `+++ b/<path>`
    (`/dev/null` for a missing side), with no `diff --git` or `index`
    lines. Hunk headers are bare `@@ -l,s +l,s @@`: Git's function-context
    text is removed. A binary pair is the single line
    `Binary files … differ`, with zero counts.
  - A proposal write whose content equals the snapshot is still listed,
    with `unified: ""` and zero counts.
  - `beforeUnavailable: true` comes with `unified: null` and zero counts;
    show the after content (`writes[].content`) only.
  - `HistoryEntry.actor` is `"human"` for a commit without an `Actor`
    trailer, such as the user's own `git revert`.
  - `history.list` pages with `before` = the last entry's `sha`, until it
    returns `[]`. An unknown `sha` or `before` is `INVALID_PARAMS`.
  - `proposals.get` takes the worktree lock, like `proposals.list`, so it
    can wait behind a long write in another process. Show a loading state.
- One `runtime/locks/turn-<sessionId>.sqlite` file per session accumulates
  over time. That is expected; cleanup can come later.
