import { describe, test, expect } from "bun:test";
import { parseToml, formatToml, TomlError } from "../../src/core/toml";

describe("parseToml", () => {
  test("parses the spec §5 brain.toml shape", () => {
    const src = `# comment
version = 1
repo_id = "01KABCDEF" # trailing comment

[links]
relationships = ["related", "supports", "contradicts", "extends", "example-of"]

[sync]
quiescence_ms = 1500

[grounding]
low_content_max_tokens = 4
confirmation_lexicon = ["yes", "yeah", "yep", "exactly", "right", "correct", "agreed", "i agree", "that's it", "that's what i mean"]
`;
    const t = parseToml(src);
    expect(t).toEqual({
      version: 1,
      repo_id: "01KABCDEF",
      links: { relationships: ["related", "supports", "contradicts", "extends", "example-of"] },
      sync: { quiescence_ms: 1500 },
      grounding: {
        low_content_max_tokens: 4,
        confirmation_lexicon: ["yes", "yeah", "yep", "exactly", "right", "correct", "agreed", "i agree", "that's it", "that's what i mean"],
      },
    });
  });

  test("strings: escapes, literal strings, apostrophes and hashes inside quotes", () => {
    const t = parseToml(`a = "x\\"y\\\\z\\n"\nb = 'no \\escapes # not a comment'\nc = "a # b"\nd = "\\u00e9"\ne = "that's it"`);
    expect(t).toEqual({ a: 'x"y\\z\n', b: "no \\escapes # not a comment", c: "a # b", d: "é", e: "that's it" });
    expect(() => parseToml("x = 'it''s'")).toThrow(TomlError);
  });

  test("numbers, booleans, negative, floats, underscores", () => {
    expect(parseToml("a = -3\nb = 1.5\nc = true\nd = false\ne = 1_000")).toEqual({ a: -3, b: 1.5, c: true, d: false, e: 1000 });
  });

  test("arrays may span lines and carry trailing commas and comments", () => {
    const t = parseToml(`xs = [\n  "a", # first\n  'b',\n  3,\n]\nempty = []`);
    expect(t).toEqual({ xs: ["a", "b", 3], empty: [] });
  });

  test("dotted table headers and dotted keys", () => {
    expect(parseToml("[a.b]\nc = 1\nd.e = 2")).toEqual({ a: { b: { c: 1, d: { e: 2 } } } });
  });

  test("CRLF and BOM tolerated", () => {
    expect(parseToml("﻿version = 1\r\n[s]\r\nk = \"v\"\r\n")).toEqual({ version: 1, s: { k: "v" } });
  });

  test("rejects unsupported or malformed input", () => {
    expect(() => parseToml("a = ")).toThrow(TomlError);
    expect(() => parseToml('a = "unterminated')).toThrow(TomlError);
    expect(() => parseToml("a = 1 b = 2")).toThrow(TomlError);
    expect(() => parseToml("a = 1\na = 2")).toThrow(TomlError);
    expect(() => parseToml("[[arr]]\nx = 1")).toThrow(TomlError);
    expect(() => parseToml("a = [1, 2")).toThrow(TomlError);
    expect(() => parseToml("a = 1\n[a]\nb = 2")).toThrow(TomlError);
  });

  test("formatToml round-trips through parseToml", () => {
    const table = {
      version: 1,
      repo_id: "01K",
      links: { relationships: ["related", "example-of"] },
      grounding: { low_content_max_tokens: 4, confirmation_lexicon: ["that's it", 'say "hi"'] },
    };
    const text = formatToml(table);
    expect(parseToml(text)).toEqual(table);
    expect(text).toContain('repo_id = "01K"');
    expect(text).toContain("[links]");
  });
});
