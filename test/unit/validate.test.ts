import { describe, test, expect } from "bun:test";
import { noteMd } from "../harness";
import { parseNote } from "../../src/markdown/parse";
import { buildNamespace, isLowContentTurn, isValidCreated, namespaceIssues, slugKey, validateNote } from "../../src/markdown/validate";
import { slugKey as coreSlugKey, slugFromPath } from "../../src/core/slug";

const config = { lowContentMaxTokens: 4, confirmationLexicon: ["that's what i mean", "i agree"] };

describe("slugKey", () => {
  test("is the same function as core/slug", () => {
    expect(slugKey).toBe(coreSlugKey);
  });
  test("normalizes case, diacritics, compatibility forms and whitespace", () => {
    expect(slugKey("Café")).toBe("cafe");
    expect(slugKey("Café")).toBe("cafe");
    expect(slugKey("  A   B\tC ")).toBe("a b c");
    expect(slugKey("ﬁle")).toBe("file");
    expect(slugKey("")).toBe("");
  });
  test("slugFromPath", () => {
    expect(slugFromPath("knowledge/a/b.md")).toBe("b");
    expect(slugFromPath("b.md")).toBe("b");
    expect(slugFromPath("knowledge/x.txt")).toBe("x.txt");
  });
});

describe("validateNote", () => {
  test("reports missing id/title and empty alias", () => {
    const parsed = parseNote("k/a.md", "---\nid: x\ncreated: 2026-02-30\ntype: idea\nstatus: active\naliases:\n  - \"\"\n---\nno title\n");
    const n = { ...parsed, frontmatter: { ...parsed.frontmatter, id: "" } };
    const codes = validateNote(n).map((i) => i.code).sort();
    expect(codes).toEqual(["INVALID_ALIAS", "INVALID_CREATED", "MISSING_ID", "MISSING_TITLE"]);
  });
  test("isValidCreated checks real calendar dates", () => {
    expect(isValidCreated("2026-09-28")).toBe(true);
    expect(isValidCreated("2024-02-29")).toBe(true);
    expect(isValidCreated("2023-02-29")).toBe(false);
    expect(isValidCreated("2026-13-01")).toBe(false);
    expect(isValidCreated("26-09-28")).toBe(false);
    expect(isValidCreated("2026-09-28T00:00")).toBe(false);
  });
});

describe("namespace", () => {
  const a = parseNote("k/agent-autonomy.md", noteMd({ id: "n1", title: "A", aliases: ["Autonomy"] }));
  const b = parseNote("k/git-trust.md", noteMd({ id: "n2", title: "B", aliases: ["Agent-Autonomy", "Trust"] }));
  const c = parseNote("k/Agent-Autonomy.md", noteMd({ id: "n3", title: "C" }));
  const d = parseNote("k/other.md", noteMd({ id: "n1", title: "D", aliases: ["trust"] }));

  test("buildNamespace: slug wins over alias, first owner kept", () => {
    const ns = buildNamespace([a, b]);
    expect(ns.get("agent-autonomy")).toBe("n1");
    expect(ns.get("autonomy")).toBe("n1");
    expect(ns.get("git-trust")).toBe("n2");
    expect(ns.get("trust")).toBe("n2");
  });

  test("namespaceIssues: slug collision, alias collision, duplicate id", () => {
    const codes = namespaceIssues([a, b, c, d]).map((i) => [i.code, i.path]);
    expect(codes).toContainEqual(["SLUG_COLLISION", "k/Agent-Autonomy.md"]);
    expect(codes).toContainEqual(["ALIAS_COLLISION", "k/git-trust.md"]);
    expect(codes).toContainEqual(["ALIAS_COLLISION", "k/other.md"]);
    expect(codes).toContainEqual(["DUPLICATE_ID", "k/other.md"]);
    expect(namespaceIssues([a, b].map((n) => ({ ...n, frontmatter: { ...n.frontmatter, aliases: [] } })))).toEqual([]);
  });
});

describe("isLowContentTurn", () => {
  test("lexicon match is symmetric under punctuation stripping and exceeds the token limit", () => {
    expect(isLowContentTurn("That's what I mean!", config)).toBe(true);
    expect(isLowContentTurn("THAT'S WHAT I MEAN", config)).toBe(true);
    expect(isLowContentTurn("that is what i mean", config)).toBe(false); // 5 tokens, not in lexicon
    expect(isLowContentTurn("", config)).toBe(true);
    expect(isLowContentTurn("one two three four", config)).toBe(true);
    expect(isLowContentTurn("one two three four five", config)).toBe(false);
    expect(isLowContentTurn("one, two; three... four -- five!", config)).toBe(false);
  });
});
