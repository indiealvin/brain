/**
 * Minimal TOML-subset parser for `brain.toml` (spec §5).
 *
 * Supported:
 *   # comments (full-line or trailing, outside strings)
 *   [section]  /  [dotted.section]
 *   key = "string"      basic strings with \" \\ \n \t \r \uXXXX escapes
 *   key = 'string'      literal strings
 *   key = 42 / -3 / 1.5 / true / false
 *   key = [ "a", 'b', 3 ]   arrays (may span lines, trailing comma ok)
 *
 * Unsupported constructs raise TomlError.
 */

export class TomlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlError";
  }
}

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

class Scanner {
  pos = 0;
  constructor(readonly src: string) {}
  peek(): string {
    return this.src[this.pos] ?? "";
  }
  eof(): boolean {
    return this.pos >= this.src.length;
  }
  skipInlineWs(): void {
    while (!this.eof() && (this.peek() === " " || this.peek() === "\t")) this.pos++;
  }
  skipWsAndComments(): void {
    for (;;) {
      while (!this.eof() && /[ \t\r\n]/.test(this.peek())) this.pos++;
      if (this.peek() === "#") {
        while (!this.eof() && this.peek() !== "\n") this.pos++;
        continue;
      }
      return;
    }
  }
  skipToEol(): void {
    this.skipInlineWs();
    if (this.peek() === "#") {
      while (!this.eof() && this.peek() !== "\n") this.pos++;
    }
    if (this.eof()) return;
    if (this.peek() === "\r") this.pos++;
    if (this.peek() === "\n") {
      this.pos++;
      return;
    }
    throw new TomlError(`unexpected text at offset ${this.pos}: ${JSON.stringify(this.src.slice(this.pos, this.pos + 20))}`);
  }
}

function parseBasicString(s: Scanner): string {
  // s.peek() === '"'
  s.pos++;
  let out = "";
  for (;;) {
    if (s.eof()) throw new TomlError("unterminated basic string");
    const c = s.peek();
    if (c === '"') {
      s.pos++;
      return out;
    }
    if (c === "\n") throw new TomlError("newline in basic string");
    if (c === "\\") {
      s.pos++;
      const e = s.peek();
      s.pos++;
      switch (e) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "b":
          out += "\b";
          break;
        case "f":
          out += "\f";
          break;
        case "u":
        case "U": {
          const len = e === "u" ? 4 : 8;
          const hex = s.src.slice(s.pos, s.pos + len);
          if (!new RegExp(`^[0-9A-Fa-f]{${len}}$`).test(hex)) throw new TomlError(`invalid unicode escape \\${e}${hex}`);
          out += String.fromCodePoint(parseInt(hex, 16));
          s.pos += len;
          break;
        }
        default:
          throw new TomlError(`invalid escape \\${e}`);
      }
      continue;
    }
    out += c;
    s.pos++;
  }
}

function parseLiteralString(s: Scanner): string {
  s.pos++;
  const start = s.pos;
  while (!s.eof() && s.peek() !== "'") {
    if (s.peek() === "\n") throw new TomlError("newline in literal string");
    s.pos++;
  }
  if (s.eof()) throw new TomlError("unterminated literal string");
  const out = s.src.slice(start, s.pos);
  s.pos++;
  return out;
}

function parseValue(s: Scanner): TomlValue {
  const c = s.peek();
  if (c === '"') return parseBasicString(s);
  if (c === "'") return parseLiteralString(s);
  if (c === "[") {
    s.pos++;
    const arr: TomlValue[] = [];
    for (;;) {
      s.skipWsAndComments();
      if (s.peek() === "]") {
        s.pos++;
        return arr;
      }
      arr.push(parseValue(s));
      s.skipWsAndComments();
      if (s.peek() === ",") {
        s.pos++;
        continue;
      }
      if (s.peek() === "]") {
        s.pos++;
        return arr;
      }
      throw new TomlError(`expected ',' or ']' in array at offset ${s.pos}`);
    }
  }
  const m = s.src.slice(s.pos).match(/^(true|false|[+-]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)(?=[\s,\]#]|$)/);
  if (!m) throw new TomlError(`unsupported value at offset ${s.pos}: ${JSON.stringify(s.src.slice(s.pos, s.pos + 20))}`);
  s.pos += m[0].length;
  const tok = m[1]!;
  if (tok === "true") return true;
  if (tok === "false") return false;
  const num = Number(tok.replace(/_/g, ""));
  if (Number.isNaN(num)) throw new TomlError(`invalid number: ${tok}`);
  return num;
}

function parseKey(s: Scanner): string[] {
  const parts: string[] = [];
  for (;;) {
    s.skipInlineWs();
    const c = s.peek();
    let part: string;
    if (c === '"') part = parseBasicString(s);
    else if (c === "'") part = parseLiteralString(s);
    else {
      const m = s.src.slice(s.pos).match(/^[A-Za-z0-9_-]+/);
      if (!m) throw new TomlError(`invalid key at offset ${s.pos}`);
      part = m[0];
      s.pos += part.length;
    }
    parts.push(part);
    s.skipInlineWs();
    if (s.peek() === ".") {
      s.pos++;
      continue;
    }
    return parts;
  }
}

function tableAt(root: TomlTable, path: string[]): TomlTable {
  let cur = root;
  for (const p of path) {
    const next = cur[p];
    if (next === undefined) {
      const t: TomlTable = {};
      cur[p] = t;
      cur = t;
    } else if (typeof next === "object" && !Array.isArray(next)) {
      cur = next;
    } else {
      throw new TomlError(`key ${p} is not a table`);
    }
  }
  return cur;
}

export function parseToml(src: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const s = new Scanner(src.startsWith("﻿") ? src.slice(1) : src);
  for (;;) {
    s.skipWsAndComments();
    if (s.eof()) return root;
    if (s.peek() === "[") {
      if (s.src[s.pos + 1] === "[") throw new TomlError("arrays of tables are not supported");
      s.pos++;
      const path = parseKey(s);
      s.skipInlineWs();
      if (s.peek() !== "]") throw new TomlError(`expected ']' at offset ${s.pos}`);
      s.pos++;
      current = tableAt(root, path);
      s.skipToEol();
      continue;
    }
    const keyPath = parseKey(s);
    s.skipInlineWs();
    if (s.peek() !== "=") throw new TomlError(`expected '=' after key ${keyPath.join(".")}`);
    s.pos++;
    s.skipInlineWs();
    const value = parseValue(s);
    const leaf = keyPath[keyPath.length - 1]!;
    const table = tableAt(current, keyPath.slice(0, -1));
    if (leaf in table) throw new TomlError(`duplicate key: ${keyPath.join(".")}`);
    table[leaf] = value;
    s.skipToEol();
  }
}

function formatTomlValue(v: TomlValue): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(formatTomlValue).join(", ")}]`;
  throw new TomlError("nested tables cannot be formatted inline");
}

/** Serialize a table of scalars/arrays with one level of sub-tables. */
export function formatToml(table: TomlTable): string {
  const lines: string[] = [];
  const sections: [string, TomlTable][] = [];
  for (const [k, v] of Object.entries(table)) {
    if (typeof v === "object" && !Array.isArray(v)) sections.push([k, v]);
    else lines.push(`${k} = ${formatTomlValue(v)}`);
  }
  for (const [name, sub] of sections) {
    lines.push("", `[${name}]`);
    for (const [k, v] of Object.entries(sub)) {
      if (typeof v === "object" && !Array.isArray(v)) throw new TomlError("nested tables deeper than one level are not supported");
      lines.push(`${k} = ${formatTomlValue(v)}`);
    }
  }
  return lines.join("\n") + "\n";
}
