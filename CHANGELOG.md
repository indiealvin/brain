# Changelog

User-facing changes for each release. The release workflow
(`.github/workflows/release.yml`) publishes the section for the version in
`package.json` as the GitHub release notes, and refuses to release a version
that has no section here. Collect changes under "Unreleased" and rename that
heading to `## vX.Y.Z — YYYY-MM-DD` in the change that bumps the version.

## Unreleased

### Fixed
- A knowledge repo whose `.git` is missing is no longer treated as part of
  an enclosing Git repository (a dotfiles repo in your home directory, say).
  `brain` and `brain doctor` now report "not the top level of a git
  repository" instead of creating the agent branch in that outer repo.

### Changed
- A conversation turn whose only change was already in place now reports
  "Knowledge unchanged" instead of listing it as "not applied".

### Added
- `brain rpc --stdio`: `conversation.send` streams the reply and reports each
  knowledge change as it lands (for the Mac app).

## v0.2.0 — 2026-10-02

The foundation for the native Mac app: running several `brain` processes on
one repo is now safe. Most changes are internal correctness fixes, so day-to-day
CLI use looks the same.

### Fixed
- **Running `brain watch` next to `brain chat` could silently lose a
  change.** One process could reset the agent worktree while another was
  writing a mutation into it, and that mutation was recorded as "nothing to
  change". Every write now goes through one cross-process lock. The kernel
  releases it the moment its holder dies, so pid files and timeouts are no
  longer part of locking.
- Two processes writing to the same conversation could produce duplicate turn
  ids or out-of-order replies. Each conversation now has its own turn lock.
- Accepting and rejecting the same proposal at the same time could leave both
  in effect. Exactly one decision now wins.
- Rejecting a proposal whose note you have since edited marks it STALE
  instead of REJECTED, so the agent doesn't remember a rejection of a change
  that no longer applies.
- Crash recovery is complete:
  - an accept interrupted by a crash is finished on the next run;
  - a mutation left half-done by a killed process is recovered at the next
    drain, without a restart.

### Changed
- `brain watch`: only one loop runs per repo. A second `brain watch` says
  which process owns the loop, waits, and takes over at once when that process
  exits or is killed.
- `brain doctor`:
  - new "worktree lock" check: who holds the lock, with a warning when it is
    held for a long time;
  - the "watch" check now reads the loop-owner lock instead of `watch.pid`;
  - new "brain on PATH" check: warns when the `brain` on your `PATH` is a
    different version from the one running;
  - doctor no longer opens the repo's engine, so it never hangs behind a busy
    process.
- Git 2.39 is now the minimum, down from 2.40, so the Git that ships with
  Xcode Command Line Tools on macOS passes `brain doctor`.
- `brain status` reads the pending-proposal count without waiting for a lock.
  The count is advisory and can briefly include a proposal that is about to
  become STALE.
- Running different `brain` versions against one `BRAIN_HOME` is unsupported
  from this version on. Reinstall everywhere after upgrading.

### Added
- `brain rpc --stdio`: the JSONL protocol server the Mac app will use
  (`docs/mac-app/protocol.md`), with the read methods for status, notes,
  search and conversations. Not needed for CLI use.
- `BRAIN_MODEL_SCRIPT=<file>`: answers model calls from a script, for tests.

## v0.1.4 — 2026-09-29
- `brain watch --install / --uninstall / --status` installs the daemon as a
  user service (systemd user unit on Linux, LaunchAgent on macOS).
- The watch loop keeps embeddings fresh after every change.

## v0.1.3 — 2026-09-29
- `brain chat` streams replies (Claude and OpenRouter), and the spinner
  stops on the first token.

## v0.1.2 — 2026-09-29
- `brain chat` shows a wait indicator while the model replies and while
  knowledge updates.

## v0.1.1 — 2026-09-29
- `BRAIN_MODEL_MOCK=1` never touches the network; it uses offline
  embeddings.

## v0.1.0 — 2026-09-29
- First release: `brain` as a single binary for macOS and Linux (x64,
  arm64), installed by `install.sh`.
- `brain setup` saves the provider and key to `~/.brain/config.toml`;
  `brain doctor` checks Git, the key, the model id and the embedding size;
  `brain --version`.
