# Agent-Native Personal Knowledge System — v0 Design

Status: Frozen (architecture)
Version: v0
Date: 2026-09-29

This document is the north-star design after four rounds of review. Every
contradiction found in review has been resolved here; the resolutions are
marked **Decision**. The implementation spec (`spec.md`) and the invariants
(`invariants.md`) are derived from this document and take precedence on any
mechanical detail.

---

## 1. Overview

An agent-native personal knowledge system where conversation is the primary
user interface. The user thinks by talking; the agent maintains the knowledge
base.

```
User talks → Agent understands → Durable knowledge extracted
→ Existing knowledge retrieved → Notes created / enriched / linked
→ Markdown written → Git commit → Index reconciled
```

Knowledge is stored as portable Markdown files organized around atomic,
interconnected ideas (Zettelkasten-inspired). The system should behave like a
long-term thinking partner, not a note-taking application.

## 2. Product thesis

Traditional knowledge management asks the user to do two jobs: think, and
organize the results of thinking. A capable agent can do the second job.

The knowledge base becomes a continuously maintained representation of what
the user knows, believes, has learned, has decided, is uncertain about, how
those ideas relate, and how their thinking evolves.

## 3. Core principle: conversation is the interface

The user never says "save this", "create a note", or "add a backlink".
Knowledge maintenance happens asynchronously and never blocks the reply.

## 4. Core loop

```
Conversation → Extract durable knowledge → Retrieve related notes
→ Decide (CREATE / ENRICH / LINK / EVOLVE / propose)
→ Write Markdown → Git commit → Reconcile index
```

## 5. What is stored

Conversation stores what happened. Knowledge stores what remains useful:
ideas, claims, conclusions, decisions, learnings, hypotheses, questions,
evidence, observations, and relationships. Casual conversation and transient
supporting detail do not become knowledge.

**Decision.** Conversation transcripts live in the application store under
`$BRAIN_HOME/repos/<repo_id>/conversations/`, never in the knowledge repo.
Provenance references use stable URIs (`conversation://<session>/<turn>`), and
a note must carry enough grounded quote or paraphrase to be interpretable
without the transcript.

## 6. Atomic knowledge model

One durable conceptual unit per note. A note deserves to exist independently
if the idea can stand on its own and may be referenced later.

## 7. Knowledge mutation policy

Before any change the agent retrieves related notes, then chooses:

| Operation | Meaning | v0 permission |
|---|---|---|
| CREATE | new distinct durable concept | automatic |
| ENRICH | strengthen / qualify / extend / clarify the same idea with **grounded** content | automatic |
| LINK | relate two independent ideas | automatic |
| ADD_ALIAS | add a resolvable name | automatic |
| ADDITIVE_EVOLVE | append a dated, grounded evolution entry; may weaken `active → tentative` | automatic |
| RECONCILE_EVOLUTION | rewrite the current claim, strengthen certainty, mark superseded, change type, resolve a question | proposal |
| MERGE | notes represent the same concept | proposal |
| ARCHIVE | `status → archived` (not a path move) | proposal |
| RENAME_SLUG | change filename; rewrite all inbound links; old slug becomes alias | explicit approval |
| DELETE | remove a note | explicit approval |

**Decision.** MOVE does not exist in v0; folders carry no semantics.
**Decision.** The agent may automatically weaken certainty but may never
automatically strengthen certainty or replace the user's asserted position.
**Decision.** Automatic operations may target only `active` or `tentative`
notes. Touching `superseded` or `archived` notes requires a proposal.

## 8. Note format

```markdown
---
id: 01K6ABCDEF...
created: 2026-09-28
type: idea
status: active
aliases:
  - Git as a trust layer
---
# Reversibility increases agent autonomy

## Claim
Reversible state transitions allow agents to operate with greater autonomy.
Grounded-in: conversation://abc/40

## Agent inference
Reversibility may reduce the need for pre-approval of low-risk mutations.
Inferred-from: conversation://abc/40

## Evolution
### 2026-11-14 — tentative
Operational UI may decline while review-oriented UI remains important.
Source: conversation://abc/42

## Connections
- supports [[agent-autonomy]]
- contradicts [[approval-before-every-action]]
```

Not every note needs every section.

## 9. Identity, metadata, and naming

**Decision.**

- `id` (frontmatter, ULID) is the stable identity.
- The filename basename without `.md` is the **slug**, the stable link target.
  Slugs are repo-wide unique and case-insensitive. The agent never renames a
  slug automatically.
- The H1 is the display title. The agent may refine it. When a title changes,
  the old title is appended to `aliases` automatically.
- `aliases` are alternative resolvable names. Slugs and aliases share one
  case-insensitive namespace; slug wins on lookup; a colliding alias is
  rejected.
- `type` and `status` are human knowledge and live in frontmatter.

Required frontmatter: `id`, `created`, `type`, `status`. `aliases` optional.

Types: `idea decision hypothesis question observation reference`.
Statuses: `active tentative superseded resolved archived`.

Machine-derived data (embeddings, access counts, backlinks, ranking) never
appears in Markdown.

## 10. Links and graph

- `[[slug]]` or `[[slug|Display]]` in body prose means `related`.
- Typed edges live under `## Connections` as `- <relationship> [[slug]]`.
- v0 vocabulary: `related supports contradicts extends example-of`.
- Links may target an alias (human-written); agent-generated links use slugs.
- A dangling link is stored as unresolved. The system never creates a note
  because a wikilink points at nothing.
- Backlinks are derived, never stored.

## 11. Knowledge content classes

**Decision.** Three classes, enforced by a deterministic validator, not by
prompt:

- **Grounded**: directly supported by a user turn, an external document, or an
  imported source. An assistant turn can never ground a claim.
- **Inferred**: agent reasoning. Always visibly marked. Never promoted to
  grounded without an explicit user confirmation, and the promoted claim keeps
  its full lineage (`Originated-as`, `Grounded-in`, `Confirmed-by`).
- **Structural**: title, aliases, links, slug at CREATE, initial type and
  status. Agent-managed.

A low-content confirmation ("yeah", "exactly") cannot introduce a claim; it
can only confirm the immediately preceding identifiable inference.

Provenance needed to tell grounded from inferred lives in Markdown. If deleting
`$BRAIN_HOME` changes whether a claim reads as user-grounded, the model is
wrong.

## 12. Storage architecture

```
<knowledge repo>/            user-owned, Git
├── brain.toml               repo_id, link vocabulary (committed)
├── knowledge/
├── projects/
├── attachments/
├── AGENTS.md
└── .git/

$BRAIN_HOME/repos/<repo_id>/ application state, never committed
├── index.sqlite             derived, disposable
├── usage.sqlite             behavioral, optional, not rebuildable
├── conversations/
├── proposals/
├── worktrees/agent/         agent-only Git worktree
└── runtime/                 locks, queue
```

`BRAIN_HOME` defaults to `~/.brain`. Tests must always set it to a temp dir.

## 13. Source-of-truth model

- Markdown = knowledge.
- Git = history, safety, and the durable mutation log.
- `index.sqlite` = disposable projection of one Git commit; always
  rebuildable.
- `usage.sqlite` = optional behavioral state; loss costs personalization only.

## 14. Git model

**Decision.** Two worktrees, one branch each:

- User worktree: `main`. Edited by humans (nvim, Obsidian). A **Human Sync**
  component commits quiescent human edits with `Actor: human-sync`.
- Agent worktree: `agent/repo`. Every automatic mutation is committed here
  immediately with a `Mutation-ID` trailer. The agent branch **is** the
  repo-wide pending view; there is no separate overlay.

Integration runs `git merge --ff-only agent/repo` inside the user worktree
under a repo-wide lock shared with Human Sync. When `main` advances, the
agent branch is rebuilt: each pending mutation's preconditions are validated
sequentially against the evolving rebuild tree; valid ones are cherry-picked,
invalid ones and their dependency closure go to REPLAN. Git rebases are
routine mechanical transport; a cherry-pick conflict is a bug.

Every mutation is an optimistic transaction over an explicit set of
note-level write preconditions (`PRESENT(note_id, path, blob)` /
`ABSENT(slug)`), verified at plan time, re-verified at rebuild, and matched
against the actual write set after execution.

## 15. Retrieval

Hybrid: lexical (FTS5, and `rg` outside the app) + semantic (embeddings on a
retrieval representation of title, claim, grounded content) + graph
proximity. Candidates are unioned and reranked. The planner reads exactly
one indexed view: `agent/repo` HEAD.

## 16. Scale target

Normal 1K–20K notes, heavy 20K–100K. Indexing is incremental and keyed on
commits; full rebuild is a correctness fallback, not a normal path.

## 17. Frontend

v0 surfaces: Chat, Search, Note, Changes, **Proposal Inbox**. The reply
streams immediately; "Knowledge updated" arrives later via event. Proposals
persist in an inbox and are never only a chat chip. No editor; Markdown is
edited with external tools.

## 18. Graceful degradation

If the application, index, embedding provider, or model disappears, the
user keeps Markdown + wikilinks + aliases + attachments + Git history, and
`nvim`, `rg`, `fzf`, `git`, and Obsidian keep working.

## 19. v0 non-goals

Databases, block editing, canvas, visual graph, tasks, calendar, deep
folders, ontology, collaboration, mobile, custom editor, separate vector DB,
MOVE, read-set invalidation (only write-set preconditions in v0).

## 20. Primary risk and evaluation

The primary risk is knowledge quality: under-capture and over-capture.
Therefore evals are a v0 deliverable, split into:

- **Contract tests**: deterministic, no model calls, mocked planner output.
- **Model evals**: extraction precision/recall/overcapture, mutation decision
  accuracy, duplicate rate, retrieval Recall@k/MRR, **ungrounded content rate**
  (blocking), re-proposal rate.
- **Trust metrics** from dogfood: revert rate, manual correction rate,
  proposal accept/reject/response rate, review latency, stale-before-review,
  NOOP rate.

## 21. Success criteria

Capture, recall, integration, connection, continuity, trust, portability. The
product validation question: does the user stop feeling responsible for
maintaining the structure of their knowledge?
