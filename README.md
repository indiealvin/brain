# brain — agent-native personal knowledge system (v0)

Conversation is the interface. The agent maintains a Markdown + Git knowledge
base; every automatic change is an optimistic transaction over note-level
preconditions, committed on an agent branch and fast-forwarded into `main`.

- `docs/design.md` — product and architecture design (frozen)
- `docs/spec.md` — implementation spec (mechanisms)
- `docs/invariants.md` — the behavioral contracts every phase preserves
- `todo.md` — phase plan and validation status

## Requirements

Bun ≥ 1.4 (bundled SQLite has FTS5), Git ≥ 2.40. A Claude API credential
(`ANTHROPIC_API_KEY` or `ant auth login`) for `brain chat`; everything else
runs offline.

## Quick start

```bash
bun install
bun test                       # contract fixtures + unit tests, no network

# create a knowledge repo (any directory becomes one)
bun src/cli.ts init ~/notes
cd ~/notes
bun /path/to/brain/src/cli.ts status
bun /path/to/brain/src/cli.ts chat            # REPL; /quit to exit
bun /path/to/brain/src/cli.ts chat --once "I think Git is a trust layer for agents" --wait
bun /path/to/brain/src/cli.ts search "agent autonomy"
bun /path/to/brain/src/cli.ts proposals list
bun /path/to/brain/src/cli.ts watch           # daemon: human sync + integrate loop
```

`BRAIN_HOME` (default `~/.brain`) holds all derived state per repo:
`index.sqlite`, `queue.sqlite`, `proposals.sqlite`, `conversations/`, the
agent worktree. Deleting it never loses knowledge; `brain index --rebuild`
recreates the index from Git.

Environment: `BRAIN_MODEL` (default `claude-opus-5-5`), `BRAIN_EFFORT`,
`BRAIN_MODEL_MOCK=1` (canned model for smoke tests).

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
