# brain — agent-native personal knowledge system (v0)

Conversation is the interface. The agent maintains a Markdown + Git knowledge
base; every automatic change is an optimistic transaction over note-level
preconditions, committed on an agent branch and fast-forwarded into `main`.

- `docs/design.md` — product and architecture design (frozen)
- `docs/spec.md` — implementation spec (mechanisms)
- `docs/invariants.md` — the behavioral contracts every phase preserves
- `todo.md` — phase plan and validation status

## Install

Single binary, no runtime to install. Needs Git ≥ 2.39 and an API key from
OpenRouter or Anthropic.

```bash
curl -fsSL https://github.com/indiealvin/brain/releases/latest/download/install.sh | sh
brain setup                    # provider + key, saved to ~/.brain/config.toml (mode 600)
brain doctor                   # checks git, key, model id, embedding dims
```

macOS, Linux (x64 and arm64). Set `BRAIN_INSTALL_DIR` to change the target
directory (default `~/.local/bin`).

Mixed versions are unsupported from v0.2.0 on: every `brain` process sharing a
`BRAIN_HOME` (the CLI, the `brain watch` service, the Mac app's bundled copy)
must be the same version. `brain doctor` warns when the `brain` on `PATH` is a
different version from the one running it.

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

## What you can do

Your knowledge base is a Git repo of Markdown notes under `knowledge/`.
You talk; the agent keeps the notes. Everything below works from the
terminal, and every change is a Git commit you can read and undo.

### Think out loud, and let the agent keep the notes

```console
$ brain chat
> I think cheap undo matters more than approval prompts for agents
So cheap undo turns approval into an after-the-fact review. …
Knowledge updated · 1 note (1 created)
```

You get the reply first. The agent then extracts what *you* said, decides
how it fits your existing notes, and commits the change. The summary line
appears when that is done. The reply never waits for it. Only your own
words become knowledge: each claim records the turn it came from
(`Grounded-in: conversation://<session>/<turn>`), and the assistant's
replies never count as a source. Relevant notes are pulled into the
conversation, and the reply cites them by title. `/proposals` lists pending
proposals and `/quit` (or Ctrl-D) exits.

### Capture a thought without leaving the shell

```bash
brain chat --once "Idea: weekly review of rejected proposals" --wait
brain chat --session <id> --once "and also …"     # continue that conversation
```

`--once` sends one message and prints the reply; `--wait` also prints the
knowledge summary before exiting. The session id is printed on stderr. Use
it in scripts, editor commands, or a hotkey.

### Find what you thought before

```console
$ brain search "agent autonomy"
0.800  Undo replaces approval  (knowledge/undo-replaces-approval.md)  [lexical=1.00 semantic=1.00]
```

Hybrid search: full text, embeddings and the link graph. `--limit n` caps
the results. `--json` gives machine-readable output here and on most other
commands.

### Review the agent's bigger changes

The agent applies additive changes on its own: new notes, enrichments,
links, aliases, and additive evolution of an idea. The only automatic
downgrade is `active` → `tentative`. Anything that removes or reshapes what
you believe (merge, archive, delete, rename, reconciling a changed position)
becomes a **proposal** that waits for you:

```bash
brain proposals list
brain proposals show <id>          # what it would write or delete, and why
brain proposals accept <id>        # executes it as one commit
brain proposals reject <id> --note "these are different ideas"
```

Rejections are remembered: whenever the agent plans a change to those notes
again, it sees your rejection (and your note) and is told not to propose the
same thing. If you edited a note after the proposal was made, rejecting or
accepting marks the proposal `STALE` instead, and nothing is executed.

### Edit notes yourself, in any editor

Notes are plain Markdown with YAML frontmatter, so you can open the repo in
Obsidian, VS Code, or vim. `brain sync` (or `brain watch`) commits your edits
on `main` once the files have been untouched for `sync.quiescence_ms`
(1.5 s by default, in `brain.toml`). The agent writes in its own worktree
on the `agent/repo` branch and reaches `main` only by fast-forward. It never
stashes, resets, or overwrites a file you haven't committed; if your edits
are in the way, integration waits. Your commits and the agent's are never
mixed. `AGENTS.md` in the repo describes the note format for other coding
agents.

### See and undo what the agent did

Every agent commit names its mutation and actor in Git trailers:

```console
$ git log --grep "Actor: agent" --format='%h %s'
d3aa936 knowledge: create Undo replaces approval
$ git show d3aa936                  # Mutation-ID, Mutation-Type, Actor trailers
$ git revert d3aa936                # undo it like any other commit
```

The agent's commits, including the proposals you accept, carry
`Actor: agent`; your edits committed by `brain sync` or `brain watch` carry
`Actor: human-sync`. A revert is your own commit: the agent rebuilds on top
of it and the index follows.

### Keep it running in the background

```bash
brain watch --install              # start at login, restart on failure
brain watch --status
brain status                       # heads, queue, pending proposals, index
brain doctor                       # what's wrong, if anything
```

Without `brain watch`, nothing runs between commands. After editing notes by
hand, run `brain integrate`: it commits your edits, brings the agent's branch
up to date, finishes any queued work, and refreshes the index. (`brain sync`
only commits your edits.)

### Try it without an API key

```bash
BRAIN_MODEL_MOCK=1 brain chat      # canned replies, no knowledge extraction
```

With `embeddings = "hashing"`, search and indexing work fully offline.

### Coming next: Brain for Mac

A native macOS app over `brain rpc --stdio` is in development
(`docs/mac-app/`). The CLI stays the full product, and the app is a client
of it.

## The watch daemon

`brain watch` commits your quiescent edits, executes queued mutations,
fast-forwards `main`, and after every change re-embeds the notes that changed
so `brain search` and `brain chat` see them without a manual `brain index`.
With `embeddings = "openrouter"` that needs the OpenRouter key (from `brain
setup`); the `hashing` embedder works offline. `--no-embeddings` turns the
step off; if the provider cannot be created the daemon logs one warning and
keeps syncing without embeddings.

One loop runs per repo. It belongs to whoever holds the repo's loop-owner
lock (`$BRAIN_HOME/repos/<repo_id>/runtime/locks/loop-owner.sqlite`), and
`brain watch` holds it for as long as it runs. A second `brain watch` for the
same repo (say, one started by hand while the service is installed) logs once
which process owns the loop and waits; Ctrl-C ends the wait. It opens the repo
only when it gets the lock. When the owner exits or is killed, the operating
system frees the lock, the waiting daemon takes over at once, and it runs one
full tick straight away. `brain doctor` reports `running (watch, pid N)` from
that lock, or `not running`. `runtime/watch.pid` is still written once the
lock is held and removed on a clean stop, but nothing relies on it: after a
crash it can name a pid that now belongs to another process.

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

Releases are driven by the `version` in `package.json`. Merging to `main` a
change that bumps it makes `.github/workflows/release.yml` tag `vX.Y.Z`,
cross-compile four targets, smoke-test the Linux binary, and publish the
assets plus `install.sh`. A merge that leaves the version unchanged releases
nothing. Pushing a tag `vX.Y.Z` by hand still works, but only when it
matches `package.json`.

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
model for smoke tests), `BRAIN_MODEL_SCRIPT=<file>` (tests: chat, extractor and
planner calls answered from a JSON script, with holds, failures and a call log;
format in `src/pipeline/scripted.ts`; wins over `BRAIN_MODEL_MOCK`). `brain watch` uses the same embedding settings, so an
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
