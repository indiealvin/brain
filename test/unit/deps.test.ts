import { describe, test, expect } from "bun:test";
import type { Mutation, QueueRow, TargetPrecondition } from "../../src/core/types";
import { closure, dependencyGraph, linkTargetKeys } from "../../src/core/deps";
import { noteMd } from "../harness";

let seq = 0;
function row(id: string, type: QueueRow["type"], targets: TargetPrecondition[], dependsOn: string[] = []): QueueRow {
  seq += 1;
  return { mutationId: id, state: "COMMITTED", type, targets, dependsOn, attemptCount: 1, createdAt: "", updatedAt: "", seq };
}
function mut(r: QueueRow, writes: Mutation["writes"]): [string, Mutation] {
  return [r.mutationId, { mutationId: r.mutationId, type: r.type, summary: "", targets: r.targets, writes, dependsOn: r.dependsOn, evidence: [] }];
}
const present = (noteId: string, path: string): TargetPrecondition => ({ kind: "present", noteId, path, blobHash: "0".repeat(40) });
const absent = (slug: string): TargetPrecondition => ({ kind: "absent", slug });
const emptyTree = { hasSlug: () => false };

describe("dependencyGraph (spec §10)", () => {
  test("rule 1: explicit dependsOn, only on known ids and never on itself", () => {
    const a = row("a", "ENRICH", [present("n1", "knowledge/n1.md")]);
    const b = row("b", "ENRICH", [present("n2", "knowledge/n2.md")], ["a", "b", "ghost"]);
    const g = dependencyGraph([a, b], new Map(), emptyTree);
    expect([...g.get("b")!]).toEqual(["a"]);
    expect(g.get("a")!.size).toBe(0);
  });

  test("rule 2: shared note id, shared absent slug, and present path matching an earlier CREATE slug; order matters", () => {
    const c = row("c", "CREATE", [absent("New-Note")]);
    const e1 = row("e1", "ENRICH", [present("n1", "knowledge/n1.md")]);
    const e2 = row("e2", "ENRICH", [present("n1", "knowledge/moved/n1.md")]); // same note id
    const e3 = row("e3", "ENRICH", [present("n9", "knowledge/new-note.md")]); // path slug matches c's absent slug
    const e4 = row("e4", "LINK", [present("n2", "knowledge/n2.md")]); // unrelated
    const g = dependencyGraph([c, e1, e2, e3, e4], new Map(), emptyTree);
    expect(g.get("e2")).toEqual(new Set(["e1"]));
    expect(g.get("e3")).toEqual(new Set(["c"]));
    expect(g.get("e4")!.size).toBe(0);
    expect(g.get("c")!.size).toBe(0);
    expect(g.get("e1")!.size).toBe(0);
  });

  test("rule 3: a link to a slug introduced by an earlier CREATE; not when the slug exists on the base tree", () => {
    const c = row("c", "CREATE", [absent("a-note")]);
    const l = row("l", "LINK", [present("nb", "knowledge/b.md")]);
    const writes: Mutation["writes"] = [{ path: "knowledge/b.md", content: noteMd({ title: "B", sections: { Claim: "see [[A-Note|A]]" } }) }];
    const withLink = new Map([mut(l, writes)]);
    expect(dependencyGraph([c, l], withLink, emptyTree).get("l")).toEqual(new Set(["c"]));
    // slug already on the base: linking to an existing note is not a dependency
    expect(dependencyGraph([c, l], withLink, { hasSlug: (k) => k === "a-note" }).get("l")!.size).toBe(0);
    // CREATE after the link, or no link content at all: no edge
    const l0 = row("l0", "LINK", [present("nc", "knowledge/c.md")]);
    const c2 = row("c2", "CREATE", [absent("z")]);
    expect(dependencyGraph([l0, c2], new Map([mut(l0, [{ path: "knowledge/c.md", content: "[[z]]" }])]), emptyTree).get("l0")!.size).toBe(0);
    expect(dependencyGraph([c, l], new Map(), emptyTree).get("l")!.size).toBe(0);
  });

  test("linkTargetKeys falls back to a regex on unparsable content", () => {
    expect(linkTargetKeys("knowledge/x.md", "no frontmatter [[Foo Bar]] and [[baz|Display]]")).toEqual(new Set(["foo bar", "baz"]));
    expect(linkTargetKeys("notes.txt", "[[q]]")).toEqual(new Set(["q"]));
  });
});

describe("closure", () => {
  test("seeds plus transitive dependents, following reverse edges only", () => {
    const g = new Map<string, Set<string>>([
      ["a", new Set()],
      ["b", new Set(["a"])],
      ["c", new Set(["b"])],
      ["d", new Set(["x"])],
      ["x", new Set()],
    ]);
    expect(closure(g, new Set(["a"]))).toEqual(new Set(["a", "b", "c"]));
    expect(closure(g, new Set(["b"]))).toEqual(new Set(["b", "c"]));
    expect(closure(g, new Set(["c"]))).toEqual(new Set(["c"]));
    expect(closure(g, new Set())).toEqual(new Set());
  });
});
