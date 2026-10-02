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

- [ ] **macOS CI result (T0.1).** Read the `test-macos` CI job log. It shows
      whether `bun:sqlite` uses the system SQLite or Bun's bundled copy,
      and whether the lock checks (`test/unit/sqliteLockPlatform.test.ts`,
      checks A1–H4) pass on macOS. Record the result in `design.md` §5.2,
      replacing "macOS has not been verified yet". If anything fails, stop:
      the whole CR-1 lock design rests on it.
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
| T3.1 | Xcode project in `apps/mac/`. Bundle the `darwin-arm64` / `darwin-x64` binaries from `bun run build:all`. Signing and notarization can wait for §2 | T1.3 (`brain rpc --stdio`) | no |
| T3.2 | BrainKit: spawn the child, JSONL codec, request correlation, notification stream, `Codable` DTOs with `unknown(String)` enum cases, `UNKNOWN_METHOD` treated as "feature absent". Replay `test/rpc/transcripts/*.jsonl` in the Swift tests: decode `msg` only, and skip `test` lines (protocol §9) | T1.3 | no |
| T3.3 | First run and Settings: repo picker, `repo.init`, `doctor.run`, keys in Keychain passed as `initialize.env`, restart the child when settings change, warn when the `brain` on `PATH` differs from the bundled one | T1.3, T0.9 | no |
| T3.4 | Conversation: sessions, streaming `reply.delta`, `SESSION_BUSY` handling. Per-turn knowledge chips appear only after T2.5 | T1.5 | no |
| T3.6 | Proposal Inbox: diff rendering (`FileDiff`, including `beforeUnavailable`), accept / reject, the `REPLAN` → "note changed" experience | T1.6, T1.8 | no |
| T3.7 | Knowledge Browser and Search: `notes.*`, pending-integration badges, "Open in external editor" | T1.4, T1.8 | no |
| T3.5 | Activity and notifications. The backlog views appear only after T2.5 | T1.7 | no |
| T3.8 | History and diff views | T1.8 | no |
| T3.9 | Quick Capture panel and menu bar | T2.4 (needs CR-5) | no |

The minimum useful alpha is T3.1–T3.4, T3.6 and T3.7. Quick Capture (T3.9)
needs CR-5 and M2.

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
- One `runtime/locks/turn-<sessionId>.sqlite` file per session accumulates
  over time. That is expected; cleanup can come later.
