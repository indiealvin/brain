# brain — agent-native personal knowledge system (v0)

Conversation is the interface. The agent maintains a Markdown + Git knowledge
base; every automatic change is an optimistic transaction over note-level
preconditions, committed on an agent branch and fast-forwarded into `main`.

- `docs/design.md` — product and architecture design (frozen)
- `docs/spec.md` — implementation spec (mechanisms)
- `docs/invariants.md` — the behavioral contracts every phase preserves
- `todo.md` — phase plan and validation status

## Install

Single binary, no runtime to install. Needs Git ≥ 2.40 and an API key from
OpenRouter or Anthropic.

```bash
curl -fsSL https://github.com/indiealvin/brain/releases/latest/download/install.sh | sh
brain setup                    # provider + key, saved to ~/.brain/config.toml (mode 600)
brain doctor                   # checks git, key, model id, embedding dims
```

macOS, Linux (x64 and arm64). Set `BRAIN_INSTALL_DIR` to change the target
directory (default `~/.local/bin`).

## Quick start

```bash
brain init ~/notes             # any directory becomes a knowledge repo
cd ~/notes
brain chat                     # REPL; /quit to exit, /proposals to list
brain chat --once "I think Git is a trust layer for agents" --wait
brain search "agent autonomy"
brain proposals list
brain watch                    # daemon: human sync + integrate loop, keeps embeddings fresh
brain watch --install          # …as a user service (systemd --user / launchd); --status, --uninstall
```

`brain watch` commits your quiescent edits, executes queued mutations,
fast-forwards `main`, and after every change re-embeds the notes that changed
so `brain search` and `brain chat` see them without a manual `brain index`.
With `embeddings = "openrouter"` that needs the OpenRouter key (from `brain
setup`); the `hashing` embedder works offline. `--no-embeddings` turns the
step off; if the provider cannot be created the daemon logs one warning and
keeps syncing without embeddings.

`brain watch --install [--interval ms]` runs the daemon as a per-repo user
service that starts at login and restarts on failure: a systemd user unit
(`~/.config/systemd/user/brain-watch@<repo_id>.service`; run
`loginctl enable-linger $USER` on a headless machine) on Linux, a LaunchAgent
(`~/Library/LaunchAgents/io.brain.watch.<repo_id>.plist`, logs in
`$BRAIN_HOME/repos/<repo_id>/runtime/watch.log`) on macOS. The unit pins the
`BRAIN_HOME` in effect at install time and reads keys from its `config.toml`.
`brain watch --status` reports running/stopped, `brain watch --uninstall`
stops and removes it, and `brain doctor` shows whether one is installed.

## Develop

Bun ≥ 1.4 (bundled SQLite has FTS5).

```bash
bun install
bun test                       # contract fixtures + unit tests, no network
bunx tsc --noEmit
bun src/cli.ts --help          # run from source
bun run build                  # dist/brain single binary for this machine
```

Releases: push a tag `vX.Y.Z`; `.github/workflows/release.yml` cross-compiles
four targets, smoke-tests the Linux binary, and publishes the assets plus
`install.sh`.

`BRAIN_HOME` (default `~/.brain`) holds all derived state per repo:
`index.sqlite`, `queue.sqlite`, `proposals.sqlite`, `conversations/`, the
agent worktree. Deleting it never loses knowledge; `brain index --rebuild`
recreates the index from Git.

Environment: `BRAIN_MODEL_PROVIDER` (`anthropic` | `openrouter`; auto-picks
`openrouter` when only `OPENROUTER_API_KEY` is set), `BRAIN_MODEL` (default
`claude-opus-5-5` or `anthropic/claude-sonnet-4.5` on OpenRouter),
`BRAIN_EFFORT`, `BRAIN_EMBEDDINGS` (`hashing` | `openrouter`; defaults to
`openrouter` when the model provider is OpenRouter, `hashing` otherwise),
`BRAIN_EMBEDDING_MODEL`, `BRAIN_EMBEDDING_DIMS`, `BRAIN_MODEL_MOCK=1` (canned
model for smoke tests). `brain watch` uses the same embedding settings, so an
`openrouter` embedder needs `OPENROUTER_API_KEY` (or the key in `config.toml`)
in the daemon's environment; `hashing` needs nothing. Environment variables override `~/.brain/config.toml`
(written by `brain setup`; `brain doctor --offline` shows the effective values).
When developing from source you can also put them in a `.env` (gitignored)
and run `bun --env-file=.env src/cli.ts …`.

Using OpenRouter only:

```
# .env
OPENROUTER_API_KEY=sk-or-...
BRAIN_MODEL=anthropic/claude-sonnet-4.5
BRAIN_EMBEDDINGS=openrouter
BRAIN_EMBEDDING_MODEL=openai/text-embedding-3-small
BRAIN_EMBEDDING_DIMS=1536
```

## Layout

```
src/core        types, ids, queue, preconditions, executor, deps, rebuild, integrate, coordinator
src/git         subprocess wrapper, agent worktree
src/markdown    parse / serialize / validate / repo config
src/sync        RepoWorktreeLock, Human Sync
src/index       SQLite projection of agent HEAD, incremental reconcile, backlinks
src/retrieval   FTS5 + hashing embeddings + graph, hybrid rerank
src/extract     grounding validator, extractor prompts + parser
src/plan        planner prompts, context builder, materialization, mutation validator
src/proposal    proposal store and lifecycle
src/model       Claude adapter (ModelProvider)
src/conversation JSONL conversation store
src/pipeline    reply + async knowledge maintenance
src/cli.ts      brain CLI
test/fixtures   read-only behavioral contracts (spec §3)
test/harness    fixture helpers, independent of the implementation
test/unit       per-module tests
```

## Invariant summary

Human and agent commits never mix. Every mutation records `PRESENT(note,
path, blob)` / `ABSENT(slug)` preconditions at plan time and is re-validated
sequentially on rebuild; stale ones go to REPLAN and are never replayed.
The executor is model-free. Assistant turns never ground a claim. Only
`active → tentative` is automatic; every belief-strengthening change is a
proposal. See `docs/invariants.md`.
