/**
 * Deterministic mutation validator for planner output (spec §36, §30–31;
 * I-14, I-15, I-16, I-17, I-21, I-22).
 *
 * Planner output is untrusted until this passes it. Pure: no I/O, no model
 * calls. Every check is a function of the mutation, the planner input it was
 * planned against, and the conversation turns.
 *
 * Grounding is checked as a *diff*: source URIs already present in the
 * retrieved note are assumed to have been validated when they were written
 * (their sessions are usually not in `turns`); only URIs the write adds are
 * validated against the transcript.
 */
import { AUTOMATIC_MUTATION_TYPES } from "../core/types";
import type { ConversationTurn, Mutation, ParsedNote, ValidationIssue, WikiLink } from "../core/types";
import { isNotePath, slugFromPath, slugKey } from "../core/slug";
import { validateGroundingSources } from "../extract/groundingValidator";
import { NoteParseError, parseNote } from "../markdown/parse";
import { validateNote } from "../markdown/validate";
import type { PlannerInput, PlannerNote } from "./context";

export const PLAN_ISSUE = {
  /** Proposal-only type emitted as a mutation, or a deletion in an automatic mutation. */
  PERMISSION: "PERMISSION",
  /** A write path does not map onto a declared target (or vice versa). */
  TARGET_MISMATCH: "TARGET_MISMATCH",
  /** Written note does not parse. */
  PARSE_ERROR: "PARSE_ERROR",
  /** Frontmatter id differs from the retrieved note. */
  ID_CHANGE: "ID_CHANGE",
  STATUS_TRANSITION_FORBIDDEN: "STATUS_TRANSITION_FORBIDDEN",
  TYPE_CHANGE_FORBIDDEN: "TYPE_CHANGE_FORBIDDEN",
  /** Target note is not active/tentative (I-15). */
  PROPOSAL_REQUIRED: "PROPOSAL_REQUIRED",
  /** A grounded section cites a source that does not ground (I-16). */
  UNGROUNDED: "UNGROUNDED",
  /** ADDITIVE_EVOLVE without a new, sourced Evolution entry. */
  UNGROUNDED_EVOLUTION: "UNGROUNDED_EVOLUTION",
  /** `## Agent inference` content without an `Inferred-from:` line. */
  UNMARKED_INFERENCE: "UNMARKED_INFERENCE",
  /** The write adds a wikilink whose target resolves to nothing (I-22). */
  DANGLING_LINK_ADDED: "DANGLING_LINK_ADDED",
  /** Typed Connections entry outside the configured vocabulary. */
  UNKNOWN_RELATIONSHIP: "UNKNOWN_RELATIONSHIP",
  /** `## Claim` of an existing note was rewritten (RECONCILE territory). */
  CLAIM_REWRITE: "CLAIM_REWRITE",
  /** Existing `## Evolution` entries were rewritten or removed. */
  EVOLUTION_REWRITE: "EVOLUTION_REWRITE",
  /** A new alias collides with an existing slug or alias (I-21). */
  ALIAS_COLLISION: "ALIAS_COLLISION",
} as const;

export type PlanIssueCode = (typeof PLAN_ISSUE)[keyof typeof PLAN_ISSUE];

export interface MutationValidationContext {
  input: PlannerInput;
  /** Defaults to `input.turns`. */
  turns?: ConversationTurn[];
  /**
   * Slugs (raw form) that sibling CREATE mutations in the same plan declare
   * as absent targets; links to them are not dangling (§10 rule 3).
   */
  siblingAbsentSlugs?: Iterable<string>;
}

const GROUNDED_SECTIONS = ["claim", "evidence", "evolution"] as const;
const INFERENCE_SECTION = "agent inference";
const AUTOMATIC_TARGET_STATUSES = new Set(["active", "tentative"]);
const SOURCE_LINE_RE = /^\s*(?:Grounded-in|Source):\s*(.*)$/i;
const INFERRED_FROM_RE = /^\s*Inferred-from:\s*\S/im;
const ANY_SOURCE_LINE_RE = /^\s*(?:Grounded-in|Source):\s*\S/im;
const EVOLUTION_ENTRY_RE = /^###\s+/;

function isAutomatic(type: Mutation["type"]): boolean {
  return (AUTOMATIC_MUTATION_TYPES as readonly string[]).includes(type);
}

/** Case-insensitive section lookup. */
export function sectionOf(note: ParsedNote, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(note.sections)) if (k.trim().toLowerCase() === want) return v;
  return undefined;
}

/** Whitespace-normalized text for append-only comparisons. */
export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** URIs on `Grounded-in:` / `Source:` lines of `text` (comma/whitespace separated). */
export function sourceUrisIn(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(SOURCE_LINE_RE);
    if (!m) continue;
    for (const tok of m[1]!.split(/[\s,]+/)) {
      const uri = tok.trim().replace(/[.;)]+$/, "");
      if (uri !== "") out.push(uri);
    }
  }
  return out;
}

/** Split an Evolution section body into `### ` entries (text before the first heading is ignored). */
export function evolutionEntries(body: string): { heading: string; body: string }[] {
  const entries: { heading: string; body: string }[] = [];
  let current: { heading: string; lines: string[] } | null = null;
  for (const line of body.split("\n")) {
    if (EVOLUTION_ENTRY_RE.test(line)) {
      if (current) entries.push({ heading: current.heading, body: current.lines.join("\n").trim() });
      current = { heading: line.replace(EVOLUTION_ENTRY_RE, "").trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) entries.push({ heading: current.heading, body: current.lines.join("\n").trim() });
  return entries;
}

function tryParse(path: string, raw: string): ParsedNote | null {
  try {
    return parseNote(path, raw);
  } catch (e) {
    if (e instanceof NoteParseError) return null;
    throw e;
  }
}

function linkKey(l: WikiLink): string {
  return `${l.section}\u0000${l.relationship}\u0000${l.targetKey}`;
}

/**
 * Validate one planned automatic mutation. Returns every issue found (empty
 * when the mutation may be submitted).
 */
export function validatePlannedMutation(m: Mutation, ctx: MutationValidationContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { input } = ctx;
  const turns = ctx.turns ?? input.turns;
  const push = (code: PlanIssueCode, message: string, path?: string) => {
    const issue: ValidationIssue = { code, message };
    if (path !== undefined) issue.path = path;
    issues.push(issue);
  };

  // (a) Only automatic types may be emitted as mutations here.
  if (!isAutomatic(m.type)) {
    push(PLAN_ISSUE.PERMISSION, `${m.type} requires a proposal; it cannot be an automatic mutation`);
    return issues;
  }

  // (b) Writes ↔ targets.
  const presentByPath = new Map<string, { noteId: string; path: string; blobHash: string }>();
  const absentByKey = new Map<string, string>();
  for (const t of m.targets) {
    if (t.kind === "present") presentByPath.set(t.path, t);
    else absentByKey.set(slugKey(t.slug), t.slug);
  }
  const matchedAbsent = new Set<string>();
  const seenPaths = new Set<string>();
  const notesByPath = new Map<string, PlannerNote>();
  for (const n of input.notes) notesByPath.set(n.path, n);
  const siblingKeys = new Set<string>();
  for (const s of ctx.siblingAbsentSlugs ?? []) siblingKeys.add(slugKey(s));
  const relationships = new Set(input.config.links.relationships);

  for (const w of m.writes) {
    if (seenPaths.has(w.path)) push(PLAN_ISSUE.TARGET_MISMATCH, `duplicate write for ${w.path}`, w.path);
    seenPaths.add(w.path);
    if (w.content === null) {
      push(PLAN_ISSUE.PERMISSION, `automatic ${m.type} may not delete ${w.path}; DELETE requires a proposal`, w.path);
      continue;
    }
    const present = presentByPath.get(w.path);
    let isCreate = false;
    if (!present) {
      const key = slugKey(slugFromPath(w.path));
      if (isNotePath(w.path) && absentByKey.has(key)) {
        matchedAbsent.add(key);
        isCreate = true;
      } else {
        push(PLAN_ISSUE.TARGET_MISMATCH, `write ${w.path} is not a declared target`, w.path);
        continue;
      }
    }
    if (!isNotePath(w.path)) {
      push(PLAN_ISSUE.TARGET_MISMATCH, `write ${w.path} is not a Markdown note`, w.path);
      continue;
    }

    // (c) Parse + field validation.
    const note = tryParse(w.path, w.content);
    if (!note) {
      push(PLAN_ISSUE.PARSE_ERROR, `${w.path} does not parse as a note`, w.path);
      continue;
    }
    for (const issue of validateNote(note)) issues.push({ ...issue, path: w.path });

    // Old state for present targets.
    let old: ParsedNote | null = null;
    let oldRaw = "";
    if (present) {
      const retrieved = notesByPath.get(w.path);
      if (!retrieved || retrieved.noteId !== present.noteId) {
        push(PLAN_ISSUE.TARGET_MISMATCH, `target ${present.noteId} at ${w.path} is not among the retrieved notes`, w.path);
      } else {
        oldRaw = retrieved.raw;
        old = tryParse(w.path, retrieved.raw);
        if (!old) {
          // Unparsable retrieved note: fall back to the index row for the status gate.
          if (!AUTOMATIC_TARGET_STATUSES.has(retrieved.status)) {
            push(PLAN_ISSUE.PROPOSAL_REQUIRED, `${w.path} is ${retrieved.status}; automatic ${m.type} may only target active/tentative notes`, w.path);
          }
        }
      }
    }

    if (old) {
      if (old.frontmatter.id !== note.frontmatter.id) {
        push(PLAN_ISSUE.ID_CHANGE, `${w.path} id ${old.frontmatter.id} → ${note.frontmatter.id}`, w.path);
      }
      // (e) I-15.
      if (!AUTOMATIC_TARGET_STATUSES.has(old.frontmatter.status)) {
        push(PLAN_ISSUE.PROPOSAL_REQUIRED, `${w.path} is ${old.frontmatter.status}; automatic ${m.type} may only target active/tentative notes`, w.path);
      }
      // (d) I-14.
      const os = old.frontmatter.status;
      const ns = note.frontmatter.status;
      if (os !== ns && !(os === "active" && ns === "tentative")) {
        push(PLAN_ISSUE.STATUS_TRANSITION_FORBIDDEN, `${w.path} ${os} → ${ns} requires RECONCILE_EVOLUTION`, w.path);
      }
      if (old.frontmatter.type !== note.frontmatter.type) {
        push(PLAN_ISSUE.TYPE_CHANGE_FORBIDDEN, `${w.path} ${old.frontmatter.type} → ${note.frontmatter.type} requires RECONCILE_EVOLUTION`, w.path);
      }
      // (i) Claim is append-only for every automatic operation.
      const oldClaim = normalizeText(sectionOf(old, "Claim") ?? "");
      const newClaim = normalizeText(sectionOf(note, "Claim") ?? "");
      if (oldClaim !== "" && !newClaim.startsWith(oldClaim)) {
        push(PLAN_ISSUE.CLAIM_REWRITE, `${w.path}: ## Claim was rewritten; rewriting the claim requires RECONCILE_EVOLUTION`, w.path);
      }
      // Existing Evolution entries are append-only too.
      const oldEvo = normalizeText(sectionOf(old, "Evolution") ?? "");
      const newEvo = normalizeText(sectionOf(note, "Evolution") ?? "");
      if (oldEvo !== "" && !newEvo.startsWith(oldEvo)) {
        push(PLAN_ISSUE.EVOLUTION_REWRITE, `${w.path}: existing ## Evolution entries were rewritten or removed`, w.path);
      }
      // Alias collisions (I-21): a new alias may not be owned by another note.
      const own = new Set<string>([old.slugKey, ...old.frontmatter.aliases.map(slugKey)]);
      for (const a of note.frontmatter.aliases) {
        const k = slugKey(a);
        if (k === "" || own.has(k)) continue;
        if (input.nsKeys.has(k)) push(PLAN_ISSUE.ALIAS_COLLISION, `alias ${JSON.stringify(a)} collides with an existing slug or alias`, w.path);
      }
    }

    // (f) Grounding of grounded sections: new URIs only.
    const known = new Set(sourceUrisIn(oldRaw));
    const newUris: string[] = [];
    for (const name of GROUNDED_SECTIONS) {
      const body = sectionOf(note, name);
      if (body === undefined) continue;
      for (const uri of sourceUrisIn(body)) if (!known.has(uri) && !newUris.includes(uri)) newUris.push(uri);
    }
    if (newUris.length > 0) {
      const verdict = validateGroundingSources(newUris, turns, input.config.grounding);
      for (const issue of verdict.issues) push(PLAN_ISSUE.UNGROUNDED, issue.message, w.path);
    }
    if (isCreate) {
      const claim = sectionOf(note, "Claim");
      if (claim !== undefined && claim.trim() !== "" && !ANY_SOURCE_LINE_RE.test(claim)) {
        push(PLAN_ISSUE.UNGROUNDED, `${w.path}: ## Claim carries no Grounded-in: line`, w.path);
      }
    }
    // Every Evolution entry this write adds must be sourced, whatever the op
    // is labelled; ADDITIVE_EVOLVE must additionally add at least one.
    const oldEntries = new Set(
      evolutionEntries(old ? (sectionOf(old, "Evolution") ?? "") : "").map((e) => normalizeText(`${e.heading}\n${e.body}`)),
    );
    const added = evolutionEntries(sectionOf(note, "Evolution") ?? "").filter((e) => !oldEntries.has(normalizeText(`${e.heading}\n${e.body}`)));
    if (m.type === "ADDITIVE_EVOLVE" && added.length === 0) {
      push(PLAN_ISSUE.UNGROUNDED_EVOLUTION, `${w.path}: ADDITIVE_EVOLVE adds no new ### entry under ## Evolution`, w.path);
    }
    for (const e of added) {
      if (!ANY_SOURCE_LINE_RE.test(e.body)) {
        push(PLAN_ISSUE.UNGROUNDED_EVOLUTION, `${w.path}: Evolution entry ${JSON.stringify(e.heading)} carries no Source: line`, w.path);
      }
    }

    // (g) Inferred content must be marked.
    const inference = sectionOf(note, INFERENCE_SECTION);
    if (inference !== undefined && inference.trim() !== "" && !INFERRED_FROM_RE.test(inference)) {
      push(PLAN_ISSUE.UNMARKED_INFERENCE, `${w.path}: ## Agent inference carries no Inferred-from: line`, w.path);
    }

    // (h) New links must resolve; typed edges must use the configured vocabulary.
    const oldLinks = new Set(old ? old.links.map(linkKey) : []);
    const ownKeys = new Set<string>([note.slugKey, ...note.frontmatter.aliases.map(slugKey)]);
    for (const l of note.links) {
      if (oldLinks.has(linkKey(l))) continue;
      const resolves = input.nsKeys.has(l.targetKey) || siblingKeys.has(l.targetKey) || ownKeys.has(l.targetKey);
      if (!resolves) push(PLAN_ISSUE.DANGLING_LINK_ADDED, `${w.path}: link [[${l.target}]] targets no existing note`, w.path);
      if (l.section === "connections" && !relationships.has(l.relationship)) {
        push(PLAN_ISSUE.UNKNOWN_RELATIONSHIP, `${w.path}: relationship ${JSON.stringify(l.relationship)} is not in the configured vocabulary`, w.path);
      }
    }
  }

  for (const [key, slug] of absentByKey) {
    if (!matchedAbsent.has(key)) push(PLAN_ISSUE.TARGET_MISMATCH, `absent target ${JSON.stringify(slug)} has no write`);
  }

  return issues;
}
