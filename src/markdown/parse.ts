/**
 * Note parser (spec §18–23).
 *
 * parseNote(path, raw) → ParsedNote. Throws NoteParseError when the
 * frontmatter is absent, syntactically unsupported, or missing a required key.
 * Invalid *values* (unknown type, bad date, …) are not parse errors; they are
 * reported by validateNote so callers can distinguish "not a note" from "a
 * note with problems".
 */
import type { Frontmatter, NoteStatus, NoteType, ParsedNote, WikiLink } from "../core/types";
import { slugFromPath, slugKey } from "../core/slug";
import { FrontmatterError, parseFrontmatter, splitFrontmatter } from "./frontmatter";

export class NoteParseError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "NoteParseError";
    this.path = path;
  }
}

export const CONNECTIONS_SECTION = "Connections";

const REQUIRED_KEYS = ["id", "created", "type", "status"] as const;

const WIKILINK_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]/g;
const TYPED_LINE_RE = /^\s*[-*+]\s+([^\s\[\]]+)\s+(\[\[[^\]|\n]+?(?:\|[^\]\n]*)?\]\])/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

function stripLeadingBlankLines(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start++;
  return lines.slice(start);
}

/** Section body normalization: drop surrounding blank lines, keep inner text verbatim. */
function sectionBody(lines: string[]): string {
  return stripLeadingBlankLines(lines).join("\n").replace(/\s+$/, "");
}

function extractLinks(sectionName: string, body: string): WikiLink[] {
  const links: WikiLink[] = [];
  const isConnections = sectionName.trim().toLowerCase() === CONNECTIONS_SECTION.toLowerCase();
  let inFence = false;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let typedSpan: { start: number; end: number; relationship: string } | null = null;
    if (isConnections) {
      const tm = line.match(TYPED_LINE_RE);
      if (tm && tm.index !== undefined) {
        const linkStart = line.indexOf(tm[2]!, tm.index);
        typedSpan = { start: linkStart, end: linkStart + tm[2]!.length, relationship: tm[1]! };
      }
    }
    WIKILINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(line)) !== null) {
      const target = m[1]!.trim();
      if (target === "") continue;
      const displayRaw = m[2];
      const link: WikiLink = {
        target,
        targetKey: slugKey(target),
        relationship: "related",
        section: "body",
      };
      if (displayRaw !== undefined && displayRaw.trim() !== "") link.display = displayRaw.trim();
      if (typedSpan && m.index === typedSpan.start) {
        link.relationship = typedSpan.relationship;
        link.section = "connections";
      }
      links.push(link);
    }
  }
  return links;
}

export function parseNote(path: string, raw: string): ParsedNote {
  const split = splitFrontmatter(raw);
  if (!split) throw new NoteParseError(path, "missing frontmatter");

  let fm: Record<string, string | string[]>;
  try {
    fm = parseFrontmatter(split.frontmatter);
  } catch (e) {
    if (e instanceof FrontmatterError) throw new NoteParseError(path, e.message);
    throw e;
  }

  for (const key of REQUIRED_KEYS) {
    const v = fm[key];
    if (v === undefined || Array.isArray(v) || v.trim() === "") {
      throw new NoteParseError(path, `missing required frontmatter key: ${key}`);
    }
  }

  const aliasesRaw = fm["aliases"];
  let aliases: string[];
  if (aliasesRaw === undefined || aliasesRaw === "") aliases = [];
  else if (Array.isArray(aliasesRaw)) aliases = aliasesRaw;
  else aliases = [aliasesRaw];

  const frontmatter: Frontmatter = {
    id: (fm["id"] as string).trim(),
    created: (fm["created"] as string).trim(),
    type: (fm["type"] as string).trim() as NoteType,
    status: (fm["status"] as string).trim() as NoteStatus,
    aliases,
  };

  // Body: title = first "# " line; sections = "## " headings.
  const lines = split.body.split("\n").map((l) => l.replace(/\r$/, ""));
  let title = "";
  let titleSeen = false;
  const sections: Record<string, string> = {};
  const order: string[] = [];
  let current = "";
  let buf: string[] = [];
  let inFence = false;

  const flush = () => {
    const body = sectionBody(buf);
    if (current === "" && body === "" && !(current in sections)) {
      buf = [];
      return;
    }
    if (current in sections) {
      // Duplicate heading: append, keeping the first occurrence's position.
      const prev = sections[current]!;
      sections[current] = prev === "" ? body : body === "" ? prev : `${prev}\n\n${body}`;
    } else {
      sections[current] = body;
      order.push(current);
    }
    buf = [];
  };

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (!inFence) {
      const h2 = line.match(/^##\s+(.*?)(?:\s+#+)?\s*$/);
      if (h2) {
        flush();
        current = h2[1]!.trim();
        continue;
      }
      const h1 = line.match(/^#\s+(.*?)(?:\s+#+)?\s*$/);
      if (h1 && !titleSeen) {
        titleSeen = true;
        title = h1[1]!.trim();
        continue;
      }
    }
    buf.push(line);
  }
  flush();

  const ordered: Record<string, string> = {};
  for (const name of order) ordered[name] = sections[name]!;

  const links: WikiLink[] = [];
  for (const name of order) links.push(...extractLinks(name, ordered[name]!));

  const slug = slugFromPath(path);
  return {
    path,
    slug,
    slugKey: slugKey(slug),
    frontmatter,
    title,
    sections: ordered,
    links,
    raw,
  };
}
