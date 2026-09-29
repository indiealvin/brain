/**
 * Minimal YAML-subset frontmatter reader/writer (spec §18).
 *
 * Supported grammar (everything the engine writes and everything Obsidian
 * writes for the fields we care about):
 *
 *   key: scalar                 scalar may be bare, "double-quoted" or 'single-quoted'
 *   key: []                     empty flow list
 *   key: [a, "b", 'c']          single-line flow list of scalars
 *   key:                        block list
 *     - item
 *     - "quoted item"
 *   # comment                   full-line comments are ignored
 *
 * Anything else raises `FrontmatterError`. Values are always strings.
 */

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterError";
  }
}

export type FrontmatterValue = string | string[];
export type FrontmatterMap = Record<string, FrontmatterValue>;

/**
 * Split raw note content into the frontmatter block and the body that
 * follows it. Returns null when the document does not start with `---`.
 */
export function splitFrontmatter(raw: string): { frontmatter: string; body: string } | null {
  const text = raw.startsWith("﻿") ? raw.slice(1) : raw;
  const lines = text.split("\n");
  if ((lines[0] ?? "").replace(/\r$/, "") !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    if (line === "---" || line === "...") {
      return {
        frontmatter: lines.slice(1, i).join("\n"),
        body: lines.slice(i + 1).join("\n"),
      };
    }
  }
  return null;
}

function unquoteScalar(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* fall through */
    }
    throw new FrontmatterError(`invalid double-quoted scalar: ${value}`);
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith('"') || v.startsWith("'")) {
    throw new FrontmatterError(`unterminated quoted scalar: ${value}`);
  }
  return v;
}

function parseFlowList(inner: string): string[] {
  const out: string[] = [];
  let i = 0;
  const s = inner;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    const c = s[i]!;
    let item: string;
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length) {
        if (c === '"' && s[j] === "\\") {
          j += 2;
          continue;
        }
        if (s[j] === c) break;
        j++;
      }
      if (j >= s.length) throw new FrontmatterError(`unterminated quoted item in list: [${inner}]`);
      item = unquoteScalar(s.slice(i, j + 1));
      i = j + 1;
    } else {
      let j = i;
      while (j < s.length && s[j] !== ",") j++;
      item = s.slice(i, j).trim();
      i = j;
    }
    out.push(item);
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i < s.length) {
      if (s[i] !== ",") throw new FrontmatterError(`expected ',' in list: [${inner}]`);
      i++;
    }
  }
  return out;
}

/** Parse the frontmatter block (without the `---` fences). */
export function parseFrontmatter(block: string): FrontmatterMap {
  const out: FrontmatterMap = {};
  const lines = block.split("\n").map((l) => l.replace(/\r$/, ""));
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    i++;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/);
    if (!m) throw new FrontmatterError(`unsupported frontmatter line: ${line}`);
    const key = m[1]!;
    const rest = (m[2] ?? "").trim();
    if (rest === "") {
      // Block list (or empty scalar).
      const items: string[] = [];
      let sawItem = false;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.trim() === "" || l.trim().startsWith("#")) {
          i++;
          continue;
        }
        const im = l.match(/^\s+-(?:\s+(.*))?$/);
        if (!im) break;
        sawItem = true;
        items.push(unquoteScalar(im[1] ?? ""));
        i++;
      }
      out[key] = sawItem ? items : "";
      continue;
    }
    if (rest.startsWith("[")) {
      if (!rest.endsWith("]")) throw new FrontmatterError(`unterminated flow list for ${key}`);
      out[key] = parseFlowList(rest.slice(1, -1));
      continue;
    }
    out[key] = unquoteScalar(rest);
  }
  return out;
}

/** Quote a scalar only when a bare rendering would not read back identically. */
export function formatScalar(value: string): string {
  if (value === "") return '""';
  if (
    /^[\s"'\[\]{}#&*!|>%@`]/.test(value) ||
    /^-(\s|$)/.test(value) ||
    /^[?:](\s|$)/.test(value) ||
    /\s$/.test(value) ||
    /: |\s#|\r|\n|\t/.test(value) ||
    value.endsWith(":") ||
    value === "~" ||
    value === "null"
  ) {
    return JSON.stringify(value);
  }
  return value;
}
