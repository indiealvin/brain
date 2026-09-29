/**
 * Phase 2 fixtures — Markdown parse/validate (spec §3.15a, §18–23, §28).
 * READ-ONLY for implementers.
 */
import { describe, test, expect } from "bun:test";
import { noteMd } from "../harness";
import type { GroundingConfig } from "../../src/core/types";

const config: GroundingConfig = {
  lowContentMaxTokens: 4,
  confirmationLexicon: ["yes", "yeah", "yep", "exactly", "right", "correct", "agreed", "i agree", "that's it", "that's what i mean"],
};

describe("parseNote", () => {
  test("parses frontmatter, title, sections, bare and typed links", async () => {
    const { parseNote } = await import("../../src/markdown/parse");
    const raw = noteMd({
      id: "01NOTEPARSE000000000000001",
      title: "Reversibility enables agent autonomy",
      type: "idea",
      status: "active",
      aliases: ["Git as a trust layer"],
      sections: {
        Claim: "Reversible transitions let agents act, see [[agent-autonomy|Agent autonomy]].\nGrounded-in: conversation://abc/40",
        Connections: "- supports [[agent-autonomy]]\n- contradicts [[Approval Before Every Action]]",
      },
    });
    const n = parseNote("knowledge/git-agent-trust.md", raw);
    expect(n.slug).toBe("git-agent-trust");
    expect(n.slugKey).toBe("git-agent-trust");
    expect(n.frontmatter.id).toBe("01NOTEPARSE000000000000001");
    expect(n.frontmatter.type).toBe("idea");
    expect(n.frontmatter.status).toBe("active");
    expect(n.frontmatter.aliases).toEqual(["Git as a trust layer"]);
    expect(n.title).toBe("Reversibility enables agent autonomy");
    expect(Object.keys(n.sections)).toEqual(["Claim", "Connections"]);
    expect(n.sections.Claim).toContain("Grounded-in: conversation://abc/40");

    const body = n.links.filter((l) => l.section === "body");
    expect(body.length).toBe(1);
    expect(body[0]).toMatchObject({ target: "agent-autonomy", display: "Agent autonomy", relationship: "related" });

    const conn = n.links.filter((l) => l.section === "connections");
    expect(conn.map((l) => [l.relationship, l.target])).toEqual([
      ["supports", "agent-autonomy"],
      ["contradicts", "Approval Before Every Action"],
    ]);
    expect(conn[1]!.targetKey).toBe("approval before every action");
  });

  test("missing required frontmatter throws NoteParseError", async () => {
    const { parseNote, NoteParseError } = await import("../../src/markdown/parse");
    expect(() => parseNote("knowledge/x.md", "# No frontmatter\n")).toThrow(NoteParseError);
    expect(() => parseNote("knowledge/x.md", "---\nid: abc\n---\n# T\n")).toThrow(NoteParseError);
  });

  test("serialize round-trips a parsed note", async () => {
    const { parseNote } = await import("../../src/markdown/parse");
    const { serializeNote } = await import("../../src/markdown/serialize");
    const raw = noteMd({
      id: "01NOTEPARSE000000000000002",
      title: "T",
      aliases: ["a", "b"],
      sections: { Claim: "c", Connections: "- related [[x]]" },
    });
    const n = parseNote("knowledge/t.md", raw);
    const out = serializeNote(n);
    const n2 = parseNote("knowledge/t.md", out);
    expect(n2.frontmatter).toEqual(n.frontmatter);
    expect(n2.title).toBe(n.title);
    expect(n2.sections).toEqual(n.sections);
    expect(serializeNote(n2)).toBe(out);
  });
});

describe("validateNote", () => {
  test("rejects unknown type/status and malformed created", async () => {
    const { parseNote } = await import("../../src/markdown/parse");
    const { validateNote } = await import("../../src/markdown/validate");
    const raw = "---\nid: 01X\ncreated: yesterday\ntype: musing\nstatus: maybe\n---\n# T\n";
    const n = parseNote("knowledge/t.md", raw);
    const issues = validateNote(n);
    const codes = issues.map((i) => i.code).sort();
    expect(codes).toContain("INVALID_TYPE");
    expect(codes).toContain("INVALID_STATUS");
    expect(codes).toContain("INVALID_CREATED");
  });

  test("accepts a well-formed note", async () => {
    const { parseNote } = await import("../../src/markdown/parse");
    const { validateNote } = await import("../../src/markdown/validate");
    const n = parseNote("knowledge/t.md", noteMd({ title: "T" }));
    expect(validateNote(n)).toEqual([]);
  });
});

describe("3.15a namespace", () => {
  test("slugKey is case-insensitive and NFC-normalized", async () => {
    const { slugKey } = await import("../../src/markdown/validate");
    expect(slugKey("Agent-Autonomy")).toBe(slugKey("agent-autonomy"));
    expect(slugKey("  Café ")).toBe(slugKey("café"));
  });

  test("alias colliding with another note's slug or alias is rejected; own note is not a collision", async () => {
    const { checkAliasCollision, slugKey } = await import("../../src/markdown/validate");
    const ns = new Map<string, string>([
      [slugKey("agent-autonomy"), "note1"],
      [slugKey("Git as a trust layer"), "note2"],
    ]);
    expect(checkAliasCollision("Agent-Autonomy", ns, "note3")?.code).toBe("ALIAS_COLLISION");
    expect(checkAliasCollision("git as a TRUST layer", ns, "note3")?.code).toBe("ALIAS_COLLISION");
    expect(checkAliasCollision("git as a trust layer", ns, "note2")).toBeNull();
    expect(checkAliasCollision("brand new alias", ns, "note3")).toBeNull();
  });
});

describe("3.17 low-content rule (deterministic)", () => {
  test("classifies confirmations and short turns as low-content", async () => {
    const { isLowContentTurn } = await import("../../src/markdown/validate");
    expect(isLowContentTurn("Yeah, exactly.", config)).toBe(true);
    expect(isLowContentTurn("yes", config)).toBe(true);
    expect(isLowContentTurn("That's what I mean!", config)).toBe(true);
    expect(isLowContentTurn("ok sure fine", config)).toBe(true);
    expect(isLowContentTurn("I think reversibility increases acceptable agent autonomy because mistakes are cheap.", config)).toBe(false);
    expect(isLowContentTurn("Git is a trust layer for agents", config)).toBe(false);
  });
});
