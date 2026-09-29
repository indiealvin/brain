import { describe, test, expect } from "bun:test";
import { parseFrontmatter, splitFrontmatter, formatScalar, FrontmatterError } from "../../src/markdown/frontmatter";
import { parseNote, NoteParseError } from "../../src/markdown/parse";
import { serializeNote } from "../../src/markdown/serialize";
import { noteMd } from "../harness";

describe("splitFrontmatter", () => {
  test("splits fences and returns body", () => {
    const r = splitFrontmatter("---\nid: 1\n---\n# T\nbody\n");
    expect(r).toEqual({ frontmatter: "id: 1", body: "# T\nbody\n" });
  });
  test("returns null without leading fence or without closing fence", () => {
    expect(splitFrontmatter("# T\n")).toBeNull();
    expect(splitFrontmatter("---\nid: 1\n# T\n")).toBeNull();
    expect(splitFrontmatter("")).toBeNull();
  });
  test("tolerates CRLF and BOM", () => {
    const r = splitFrontmatter("﻿---\r\nid: 1\r\n---\r\n# T\r\n");
    expect(r?.frontmatter.replace(/\r/g, "")).toBe("id: 1");
  });
});

describe("parseFrontmatter", () => {
  test("scalars, block list, flow list, empty list, comments", () => {
    const fm = parseFrontmatter(`id: 01K
# a comment
created: 2026-09-28
type: idea
status: active
aliases:
  - Git as a trust layer
  - "quoted: value"
  - 'single'
tags: [a, "b, c", 'd']
none: []
`);
    expect(fm).toEqual({
      id: "01K",
      created: "2026-09-28",
      type: "idea",
      status: "active",
      aliases: ["Git as a trust layer", "quoted: value", "single"],
      tags: ["a", "b, c", "d"],
      none: [],
    });
  });
  test("key with no value and no items is an empty scalar", () => {
    expect(parseFrontmatter("aliases:\nid: x")).toEqual({ aliases: "", id: "x" });
  });
  test("rejects unsupported syntax", () => {
    expect(() => parseFrontmatter("nested:\n  key: value")).toThrow(FrontmatterError);
    expect(() => parseFrontmatter("just text")).toThrow(FrontmatterError);
    expect(() => parseFrontmatter('a: "unterminated')).toThrow(FrontmatterError);
    expect(() => parseFrontmatter("a: [x")).toThrow(FrontmatterError);
  });
});

describe("formatScalar", () => {
  test("quotes only when necessary, and the result reads back identically", () => {
    const cases = ["plain", "with spaces", "", " leading", "trailing ", "a: b", "#hash", "[x]", '"q"', "'s'", "-dash", "- item", "-", "null", "colon:", "it's fine", "C# notes", "a #b", "x-y", "? q"];
    for (const c of cases) {
      const fm = parseFrontmatter(`k: ${formatScalar(c)}`);
      expect(fm["k"]).toBe(c);
    }
    expect(formatScalar("plain")).toBe("plain");
    expect(formatScalar("it's fine")).toBe("it's fine");
    expect(formatScalar("a: b")).toBe('"a: b"');
    // Harness fixtures read aliases back raw (no unquoting): common title shapes must stay bare.
    for (const bare of ["C# notes", "-dash", "x-y", "Git as a trust layer", "Reversibility enables agent autonomy", "it's fine"]) {
      expect(formatScalar(bare)).toBe(bare);
    }
  });
});

describe("parseNote details", () => {
  test("preamble between H1 and first H2 becomes section \"\" only when non-empty", () => {
    const n = parseNote("knowledge/a.md", "---\nid: 1\ncreated: 2026-01-01\ntype: idea\nstatus: active\n---\n# T\n\nintro [[x]]\n\n## Claim\nc\n");
    expect(Object.keys(n.sections)).toEqual(["", "Claim"]);
    expect(n.sections[""]).toBe("intro [[x]]");
    expect(n.links.map((l) => l.target)).toEqual(["x"]);
    const n2 = parseNote("knowledge/a.md", "---\nid: 1\ncreated: 2026-01-01\ntype: idea\nstatus: active\n---\n# T\n\n\n## Claim\nc\n");
    expect(Object.keys(n2.sections)).toEqual(["Claim"]);
  });

  test("typed links only in Connections; other lists elsewhere are bare related links", () => {
    const n = parseNote(
      "knowledge/a.md",
      noteMd({ title: "T", sections: { Evidence: "- supports [[not-typed]]", Connections: "- extends [[a|A]] and [[b]]\nplain [[c]]\n- [[d]]\n- weird-rel [[e]] # note" } }),
    );
    const typed = n.links.filter((l) => l.section === "connections").map((l) => [l.relationship, l.target]);
    expect(typed).toEqual([
      ["extends", "a"],
      ["weird-rel", "e"],
    ]);
    const bare = n.links.filter((l) => l.section === "body").map((l) => l.target);
    expect(bare).toEqual(["not-typed", "b", "c", "d"]);
    expect(n.links.find((l) => l.target === "a")?.display).toBe("A");
  });

  test("links in fenced code are ignored; headings inside fences do not split sections", () => {
    const n = parseNote("knowledge/a.md", noteMd({ title: "T", sections: { Claim: "```\n## not a heading\n[[nope]]\n```\n[[yes]]" } }));
    expect(Object.keys(n.sections)).toEqual(["Claim"]);
    expect(n.links.map((l) => l.target)).toEqual(["yes"]);
  });

  test("missing title yields empty title (validator reports it); values are not validated at parse time", () => {
    const n = parseNote("knowledge/a.md", "---\nid: 1\ncreated: x\ntype: y\nstatus: z\n---\nno heading\n");
    expect(n.title).toBe("");
    expect(n.frontmatter.type as string).toBe("y");
  });

  test("unsupported frontmatter syntax and empty required values throw NoteParseError", () => {
    expect(() => parseNote("k/a.md", "---\nid: 1\ncreated: 2026-01-01\ntype: idea\nstatus:\n---\n# T\n")).toThrow(NoteParseError);
    expect(() => parseNote("k/a.md", "---\nid: 1\ncreated: 2026-01-01\ntype: idea\nstatus: active\nx:\n  y: z\n---\n# T\n")).toThrow(NoteParseError);
  });

  test("headings keep a trailing '#' that is part of the text; space-preceded closing hashes are stripped", () => {
    const n = parseNote("k/a.md", "---\nid: 1\ncreated: 2026-01-01\ntype: idea\nstatus: active\n---\n# C# ##\n\n## F# #\nx\n## Closed ##\ny\n");
    expect(n.title).toBe("C#");
    expect(Object.keys(n.sections)).toEqual(["F#", "Closed"]);
  });

  test("slug from nested path and case-insensitive extension", () => {
    const n = parseNote("knowledge/sub/My-Note.MD", noteMd({ title: "T" }));
    expect(n.slug).toBe("My-Note");
    expect(n.slugKey).toBe("my-note");
  });

  test("serialize is idempotent and stable for preamble, aliases needing quotes, and CRLF input", () => {
    const raw = "---\r\nid: 1\r\ncreated: 2026-01-01\r\ntype: idea\r\nstatus: active\r\naliases:\r\n  - \"a: b\"\r\n  - plain\r\n---\r\n# T\r\n\r\nintro\r\n\r\n## Claim\r\n\r\nc\r\nd\r\n\r\n";
    const n = parseNote("k/a.md", raw);
    const out = serializeNote(n);
    expect(out).toBe('---\nid: 1\ncreated: 2026-01-01\ntype: idea\nstatus: active\naliases:\n  - "a: b"\n  - plain\n---\n# T\n\nintro\n\n## Claim\nc\nd\n');
    const n2 = parseNote("k/a.md", out);
    expect(n2.frontmatter).toEqual(n.frontmatter);
    expect(n2.sections).toEqual(n.sections);
    expect(n2.links).toEqual(n.links);
    expect(serializeNote(n2)).toBe(out);
  });
});

describe("unknown frontmatter keys (P2.6)", () => {
  test("parseNote collects unknown scalar keys in file order; serializeNote re-emits them after aliases", async () => {
    const { parseNote } = await import("../../src/markdown/parse");
    const { serializeNote } = await import("../../src/markdown/serialize");
    const raw = [
      "---",
      "id: 01NOTEEXTRA00000000000001",
      "zeta: last one",
      "created: 2026-09-28",
      "type: idea",
      "tags: [a, b]",
      "status: active",
      "author: \"Jane: Doe\"",
      "aliases:",
      "  - Old",
      "---",
      "# T",
      "",
      "## Claim",
      "c",
      "",
    ].join("\n");
    const n = parseNote("knowledge/t.md", raw);
    expect(n.frontmatter.extra).toEqual({ zeta: "last one", author: "Jane: Doe" });
    expect(Object.keys(n.frontmatter.extra!)).toEqual(["zeta", "author"]);
    const out = serializeNote(n);
    expect(out.startsWith(
      ["---", "id: 01NOTEEXTRA00000000000001", "created: 2026-09-28", "type: idea", "status: active", "aliases:", "  - Old", "zeta: last one", 'author: "Jane: Doe"', "---", "# T"].join("\n"),
    )).toBe(true);
    const n2 = parseNote("knowledge/t.md", out);
    expect(n2.frontmatter).toEqual(n.frontmatter);
    expect(serializeNote(n2)).toBe(out);
  });

  test("no unknown keys leaves extra undefined and output unchanged", async () => {
    const { parseNote } = await import("../../src/markdown/parse");
    const { serializeNote } = await import("../../src/markdown/serialize");
    const raw = "---\nid: 01NOTEEXTRA00000000000002\ncreated: 2026-09-28\ntype: idea\nstatus: active\n---\n# T\n";
    const n = parseNote("knowledge/t.md", raw);
    expect("extra" in n.frontmatter).toBe(false);
    expect(serializeNote(n)).toBe(raw);
  });
});
