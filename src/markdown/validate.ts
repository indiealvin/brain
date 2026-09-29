/**
 * Deterministic Markdown validators (spec §18–22, §28; I-16, I-17, I-21).
 */
import { NOTE_STATUSES, NOTE_TYPES } from "../core/types";
import type { GroundingConfig, ParsedNote, ValidationIssue } from "../core/types";
import { slugKey } from "../core/slug";

export { slugKey };

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidCreated(created: string): boolean {
  const m = created.match(DATE_RE);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Field-level validation of a single note. */
export function validateNote(note: ParsedNote): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const path = note.path;
  const fm = note.frontmatter;

  if (!fm.id || fm.id.trim() === "") {
    issues.push({ code: "MISSING_ID", message: "frontmatter `id` is required", path });
  }
  if (!(NOTE_TYPES as readonly string[]).includes(fm.type)) {
    issues.push({ code: "INVALID_TYPE", message: `unknown note type: ${JSON.stringify(fm.type)}`, path });
  }
  if (!(NOTE_STATUSES as readonly string[]).includes(fm.status)) {
    issues.push({ code: "INVALID_STATUS", message: `unknown note status: ${JSON.stringify(fm.status)}`, path });
  }
  if (!isValidCreated(fm.created)) {
    issues.push({ code: "INVALID_CREATED", message: `\`created\` must be YYYY-MM-DD, got ${JSON.stringify(fm.created)}`, path });
  }
  if (note.title.trim() === "") {
    issues.push({ code: "MISSING_TITLE", message: "note has no `# Title` heading", path });
  }
  for (const a of fm.aliases) {
    if (a.trim() === "") {
      issues.push({ code: "INVALID_ALIAS", message: "empty alias", path });
    }
  }
  return issues;
}

/**
 * Alias collision against the shared slug/alias namespace (§22, I-21).
 * `namespace` maps slugKey → owning noteId. An entry owned by `selfNoteId`
 * is not a collision.
 */
export function checkAliasCollision(
  alias: string,
  namespace: Map<string, string>,
  selfNoteId: string,
): ValidationIssue | null {
  const key = slugKey(alias);
  const owner = namespace.get(key);
  if (owner === undefined || owner === selfNoteId) return null;
  return {
    code: "ALIAS_COLLISION",
    message: `alias ${JSON.stringify(alias)} collides with a slug or alias of note ${owner}`,
  };
}

/**
 * Build the namespace from a set of notes: slugs first (slug wins), then
 * aliases. On a conflict the first owner is kept; use `namespaceIssues` to
 * detect conflicts.
 */
export function buildNamespace(notes: ParsedNote[]): Map<string, string> {
  const ns = new Map<string, string>();
  for (const n of notes) {
    if (!ns.has(n.slugKey)) ns.set(n.slugKey, n.frontmatter.id);
  }
  for (const n of notes) {
    for (const a of n.frontmatter.aliases) {
      const k = slugKey(a);
      if (k === "") continue;
      if (!ns.has(k)) ns.set(k, n.frontmatter.id);
    }
  }
  return ns;
}

/** Repo-wide namespace problems: duplicate slugs, colliding aliases, duplicate ids. */
export function namespaceIssues(notes: ParsedNote[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const slugOwner = new Map<string, ParsedNote>();
  const idOwner = new Map<string, ParsedNote>();
  for (const n of notes) {
    const prevSlug = slugOwner.get(n.slugKey);
    if (prevSlug) {
      issues.push({
        code: "SLUG_COLLISION",
        message: `slug ${JSON.stringify(n.slug)} collides with ${prevSlug.path}`,
        path: n.path,
      });
    } else {
      slugOwner.set(n.slugKey, n);
    }
    const prevId = idOwner.get(n.frontmatter.id);
    if (prevId) {
      issues.push({
        code: "DUPLICATE_ID",
        message: `id ${n.frontmatter.id} is also used by ${prevId.path}`,
        path: n.path,
      });
    } else {
      idOwner.set(n.frontmatter.id, n);
    }
  }
  const ns = new Map<string, string>();
  for (const [k, n] of slugOwner) ns.set(k, n.frontmatter.id);
  for (const n of notes) {
    const seenOwn = new Set<string>();
    for (const a of n.frontmatter.aliases) {
      const k = slugKey(a);
      if (k === "" || seenOwn.has(k)) continue;
      seenOwn.add(k);
      const collision = checkAliasCollision(a, ns, n.frontmatter.id);
      if (collision) {
        issues.push({ ...collision, path: n.path });
      } else if (!ns.has(k)) {
        ns.set(k, n.frontmatter.id);
      }
    }
  }
  return issues;
}

/**
 * Normalize a turn for the low-content rule (§28): lowercase, drop
 * apostrophes, replace other punctuation with spaces, collapse whitespace.
 */
export function normalizeTurnText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Deterministic low-content rule (§28, I-16): true when the normalized turn
 * has ≤ lowContentMaxTokens whitespace tokens, or matches an entry of the
 * confirmation lexicon exactly (lexicon entries normalized the same way).
 */
export function isLowContentTurn(text: string, config: GroundingConfig): boolean {
  const norm = normalizeTurnText(text);
  const tokens = norm === "" ? 0 : norm.split(" ").length;
  if (tokens <= config.lowContentMaxTokens) return true;
  for (const entry of config.confirmationLexicon) {
    if (normalizeTurnText(entry) === norm) return true;
  }
  return false;
}
