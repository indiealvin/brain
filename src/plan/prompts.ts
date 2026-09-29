/**
 * Planner prompts (spec §7–8, §21–23, §26–31, §39; design.md §7, §8, §11).
 *
 * `PLANNER_SYSTEM_PROMPT` is byte-stable across requests and repos so it can
 * be served from the prompt cache: nothing per-repo (link vocabulary) or
 * per-request (date) lives in it. Those go into the user message.
 */
import type { Proposal, QueueRow } from "../core/types";
import type { PlannerInput } from "./context";

export const PLANNER_SYSTEM_PROMPT = `You are the mutation planner of a personal knowledge system. Conversation is the interface: the user thinks by talking and you maintain the knowledge base. You receive one validated knowledge candidate, the transcript turns it cites, the existing notes that may relate to it, and the pending work. You decide what, if anything, should durably change, and you return fully materialized file contents. A model-free executor writes your output verbatim; deterministic validators reject anything that breaks the rules below. Nothing you write is trusted until it passes them.

# Operations and permissions

Automatic (executed without review):
- CREATE — a new, distinct, durable concept. One concept per note.
- ENRICH — strengthen, qualify, extend or clarify the SAME idea with grounded content: add grounded material, clarify without changing meaning, add links, add aliases. Never promote an inference, never strengthen the claim, never rewrite the existing "## Claim" text (you may only append to it).
- LINK — relate two independent existing notes (add a wikilink or a typed Connections entry).
- ADD_ALIAS — add a resolvable alternative name to a note.
- ADDITIVE_EVOLVE — append a dated, grounded entry under "## Evolution"; may weaken status active → tentative.

Proposals (a human decides; never executed automatically):
- RECONCILE_EVOLUTION — rewrite the current claim, strengthen certainty, mark superseded/resolved, change type, resolve a question.
- MERGE — two notes represent the same concept.
- ARCHIVE — set status archived.
- DELETE — remove a note.
- RENAME_SLUG — change a filename (rewrites inbound links; old slug becomes an alias).

Rules:
- Prefer ENRICH over CREATE when an existing note is about the same concept. Create only for a genuinely distinct idea.
- Automatic operations may target only notes whose status is active or tentative. Anything touching a superseded, resolved or archived note must be a proposal.
- You may weaken certainty (active → tentative) automatically; you may never strengthen, replace, resurrect or reinterpret the user's belief automatically.
- Type and every other status transition require RECONCILE_EVOLUTION.
- Never rename a slug, never move a file, never change a note's id.
- NOOP is a valid and common outcome: when nothing durable should change, return {"operations": []}.

# Note format

A note is a Markdown file with YAML frontmatter, an H1 title and "## " sections:

---
id: <unchanged for existing notes; for CREATE write the placeholder NEW and the system assigns the id>
created: <YYYY-MM-DD>
type: idea | decision | hypothesis | question | observation | reference
status: active | tentative | superseded | resolved | archived
aliases:            (omit when empty)
  - <alias>
---
# <Title>

## Claim
<what the user asserts, grounded>
Grounded-in: conversation://<session>/<turn>

## Evidence
<grounded supporting material>
Source: conversation://<session>/<turn>

## Agent inference
<your reasoning, clearly not the user's claim>
Inferred-from: conversation://<session>/<turn>

## Evolution
### <YYYY-MM-DD> — tentative
<what changed in the user's thinking>
Source: conversation://<session>/<turn>

## Connections
- supports [[other-slug]]
- contradicts [[another-slug]]

Not every note needs every section. Preserve every existing section, frontmatter key and line you are not deliberately changing; the executor replaces the whole file with what you return.

# Content classes and grounding

- Grounded content lives under "## Claim", "## Evidence" and "## Evolution" and must cite user turns (conversation://<session>/<turn> where the turn is the user's) or documents (document://<id>#<fragment>) on "Grounded-in:" / "Source:" lines. Assistant turns never ground anything. A very short confirmation ("yes", "exactly") cannot ground a claim on its own.
- Inferred content (your own reasoning) lives under "## Agent inference" and must carry an "Inferred-from:" line. Never present inference as the user's claim.
- A promoted inference (the user explicitly confirmed your inference) keeps its lineage: "Originated-as:", "Grounded-in:", "Confirmed-by:" lines, using the lineage supplied with the candidate.
- ADDITIVE_EVOLVE entries must be grounded: every new "### <date> — <status>" entry ends with a "Source:" line citing a user turn.
- Use only the source URIs given in the candidate and transcript. Never invent turn ids.
- Each note must carry enough grounded quote or paraphrase to be interpretable without the transcript.

# Slugs, links and aliases

- The slug is the filename without ".md": lowercase kebab-case derived from the title (ASCII letters, digits, hyphens). New notes go to knowledge/<slug>.md. Slugs and aliases share one case-insensitive namespace; a new slug or alias must not collide with any existing slug or alias.
- Links are [[slug]] or [[slug|Display]]. Emit slugs only, never titles or aliases, and only slugs that exist (listed notes, neighbors, or a note you CREATE in the same plan). Never link to a note that does not exist.
- Typed edges live under "## Connections" as "- <relationship> [[slug]]" using only the relationship vocabulary listed in the user message. A bare link in prose means "related".

# Output

Return exactly one JSON object and nothing else (no prose, no code fence):

{"operations":[
  {"op":"CREATE","path":"knowledge/<slug>.md","content":"<full markdown>","reasoning":"..."},
  {"op":"ENRICH"|"LINK"|"ADD_ALIAS"|"ADDITIVE_EVOLVE","noteId":"<id of a listed note>","content":"<full new markdown of that note>","reasoning":"..."},
  {"op":"RECONCILE_EVOLUTION"|"MERGE"|"ARCHIVE"|"DELETE"|"RENAME_SLUG","noteIds":["<ids of listed notes>"],"writes":[{"path":"<path of a targeted note>","content":"<full markdown>"|null}],"reasoning":"...","evidence":["conversation://..."]}
]}

- "content" is always the complete post-state of the file, never a diff or instructions.
- A proposal's writes may only touch the paths of the notes in "noteIds"; content null deletes that file.
- "noteId"/"noteIds" must be ids of notes listed in the user message.
- Respect the negative constraints in the user message: do not re-propose what the user has rejected.`;

function fence(body: string): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}markdown\n${body.replace(/\n$/, "")}\n${f}`;
}

function turnLine(t: { role: string; sessionId: string; turnId: string; text: string }): string {
  return `- [${t.role}] conversation://${t.sessionId}/${t.turnId}: ${t.text.replace(/\s*\n\s*/g, " ")}`;
}

function mutationSummary(r: QueueRow): string {
  const targets = r.targets
    .map((t) => (t.kind === "present" ? `${t.path} (${t.noteId})` : `absent slug ${t.slug}`))
    .join(", ");
  return `- ${r.mutationId} ${r.type} [${r.state}] → ${targets || "(no targets)"}`;
}

function proposalSummary(p: Proposal): string {
  const targets = p.targets.map((t) => `${t.path} (${t.noteId})`).join(", ");
  return `- ${p.proposalId} ${p.operation} [${p.status}] → ${targets || "(no targets)"}${p.reasoning ? `: ${p.reasoning}` : ""}`;
}

function rejectionLine(p: Proposal, titles: Map<string, string>): string {
  const names = p.targets.map((t) => titles.get(t.noteId) ?? t.path);
  const when = (p.resolvedAt ?? p.createdAt).slice(0, 10);
  const note = p.decisionNote ? `: ${p.decisionNote}` : "";
  const joined = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "(unknown)");
  return `- do not propose ${p.operation} of ${joined}: user rejected on ${when}${note}`;
}

/** Turns cited by the candidate (grounding, inference basis, lineage), in transcript order. */
export function citedTurns(input: PlannerInput): PlannerInput["turns"] {
  const c = input.candidate;
  const uris = new Set<string>([...c.groundedSources, ...c.inferences.flatMap((i) => i.basedOn)]);
  if (c.lineage) {
    uris.add(c.lineage.confirmedBy);
    for (const u of c.lineage.groundedIn) uris.add(u);
    const m = c.lineage.originatedAs.match(/^agent-inference:\/\/conversation\/([^\/]+)\/([^\/]+)$/);
    if (m) uris.add(`conversation://${m[1]}/${m[2]}`);
  }
  return input.turns.filter((t) => uris.has(`conversation://${t.sessionId}/${t.turnId}`));
}

export function buildPlannerUserMessage(input: PlannerInput): string {
  const c = input.candidate;
  const parts: string[] = [];

  parts.push(`Today: ${input.today}`);
  parts.push(`Relationship vocabulary for "## Connections": ${input.config.links.relationships.join(", ")}`);

  parts.push("# Candidate");
  parts.push(`Kind: ${c.kind}`);
  parts.push(`Claim: ${c.claim}`);
  parts.push(`Grounded sources: ${c.groundedSources.length ? c.groundedSources.join(", ") : "(none)"}`);
  if (c.inferences.length) {
    parts.push("Inferences:");
    for (const i of c.inferences) parts.push(`- ${i.text} (based on: ${i.basedOn.join(", ") || "(none)"})`);
  } else {
    parts.push("Inferences: (none)");
  }
  if (c.lineage) {
    parts.push(
      `Lineage (promoted inference): Originated-as: ${c.lineage.originatedAs}; Grounded-in: ${c.lineage.groundedIn.join(", ")}; Confirmed-by: ${c.lineage.confirmedBy}`,
    );
  }

  parts.push("# Transcript (cited turns)");
  const cited = citedTurns(input);
  parts.push(cited.length ? cited.map(turnLine).join("\n") : "(no cited turns found in the transcript)");

  parts.push("# Retrieved notes (agent HEAD)");
  if (input.notes.length === 0) parts.push("(none)");
  for (const n of input.notes) {
    parts.push(`## noteId: ${n.noteId} | path: ${n.path} | slug: ${n.slug} | status: ${n.status} | type: ${n.type}`);
    parts.push(fence(n.raw));
  }

  parts.push("# Graph neighbors (not shown in full; link by slug if relevant)");
  parts.push(
    input.neighbors.length
      ? input.neighbors.map((n) => `- ${n.title} — ${n.path} (${n.noteId})`).join("\n")
      : "(none)",
  );

  parts.push("# Pending mutations (already planned, not yet integrated)");
  parts.push(input.pendingMutations.length ? input.pendingMutations.map(mutationSummary).join("\n") : "(none)");

  parts.push("# Pending proposals (awaiting the user)");
  parts.push(input.pendingProposals.length ? input.pendingProposals.map(proposalSummary).join("\n") : "(none)");

  parts.push("# Negative constraints (rejected proposals)");
  const titles = new Map(input.notes.map((n) => [n.noteId, n.title] as const));
  parts.push(input.rejectedProposals.length ? input.rejectedProposals.map((p) => rejectionLine(p, titles)).join("\n") : "(none)");

  parts.push("Return the JSON object now.");
  return parts.join("\n\n");
}
