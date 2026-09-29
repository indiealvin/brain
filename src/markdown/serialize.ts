/**
 * Note serializer (spec §21.1). Produces the canonical layout:
 *
 *   ---
 *   id: …
 *   created: …
 *   type: …
 *   status: …
 *   aliases:            (only when non-empty)
 *     - …
 *   ---
 *   # Title
 *
 *   <preamble section "">   (only when non-empty)
 *
 *   ## Section
 *   body
 *
 * Round-trip contract: parseNote(serializeNote(n)) has the same frontmatter,
 * title, sections and links as n, and serializeNote is idempotent.
 */
import type { ParsedNote } from "../core/types";
import { formatScalar } from "./frontmatter";

export function serializeNote(note: ParsedNote): string {
  const fm = note.frontmatter;
  const lines: string[] = [
    "---",
    `id: ${formatScalar(fm.id)}`,
    `created: ${formatScalar(fm.created)}`,
    `type: ${formatScalar(fm.type)}`,
    `status: ${formatScalar(fm.status)}`,
  ];
  if (fm.aliases.length > 0) {
    lines.push("aliases:");
    for (const a of fm.aliases) lines.push(`  - ${formatScalar(a)}`);
  }
  lines.push("---");
  const parts: string[] = [lines.join("\n"), `# ${note.title}`, ""];

  const preamble = note.sections[""];
  if (preamble !== undefined && preamble.trim() !== "") {
    parts.push(preamble.replace(/\s+$/, ""), "");
  }
  for (const [name, body] of Object.entries(note.sections)) {
    if (name === "") continue;
    parts.push(`## ${name}`, body.replace(/^\s*\n/, "").replace(/\s+$/, ""), "");
  }
  return parts.join("\n");
}
