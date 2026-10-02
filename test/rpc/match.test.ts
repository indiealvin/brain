/**
 * The transcript matcher on its own (docs/mac-app/protocol.md §9;
 * implementation-plan T1.3): subset matching, exact arrays, the matchers in
 * the sibling `match` field, and substitution / binding. No server involved.
 */
import { describe, expect, test } from "bun:test";
import { lintMatch, matchMessage, resolvePointer, Substitutions, type MatchSpec } from "./harness/match";

const ULID_A = "01M3YYVXW2YZWXMC5XA0VFBQ7Z";
const ULID_B = "01M3YZ0VY8587TRM86CDP0F1WV";
const ULID_C = "01M3YZ1VH1ZSGMFMS8FR4PNJTY";
const SHA_A = "c1da7162d59e2ae9ae55dc448b9307875f526978";
const SHA_B = "30087a4866f3405460bff6d684e4dcc32b61bacd";

function ok(expected: unknown, actual: unknown, match?: MatchSpec, subs = new Substitutions()): boolean {
  return matchMessage(expected, actual, match, subs) === null;
}

describe("subset matching", () => {
  test("extra fields in the actual message are ignored, at every depth, including objects inside arrays", () => {
    expect(ok({ id: "1", type: "result", data: { a: 1 } }, { id: "1", type: "result", data: { a: 1, extra: true }, more: 2 })).toBe(true);
    expect(ok({ data: { turns: [{ turnId: "1" }, { turnId: "2" }] } }, { data: { turns: [{ turnId: "1", knowledge: "pending" }, { turnId: "2", at: "x" }] } })).toBe(true);
  });

  test("every expected field must be present and equal", () => {
    const f = matchMessage({ data: { a: 1, b: 2 } }, { data: { a: 1 } }, undefined, new Substitutions());
    expect(f).toEqual({ pointer: "/data/b", reason: "missing (expected 2)" });
    expect(ok({ data: { a: 1 } }, { data: { a: 2 } })).toBe(false);
    expect(ok({ data: { a: null } }, { data: { a: 0 } })).toBe(false);
    expect(ok({ data: { a: "1" } }, { data: { a: 1 } })).toBe(false);
    expect(ok({ data: {} }, { data: [] })).toBe(false);
  });

  test("arrays match exactly: same length, element by element, order kept", () => {
    expect(ok({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(ok({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
    expect(ok({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(ok({ a: [] }, { a: [1] })).toBe(false);
    expect(ok({ a: [1] }, { a: { 0: 1 } })).toBe(false);
  });
});

describe("matchers in the sibling match field", () => {
  test("<ulid>, <sha>, <iso> accept a value of that form and nothing else", () => {
    const cases: [MatchSpec[string], unknown, boolean][] = [
      ["<ulid>", ULID_B, true],
      ["<ulid>", "01m3yz0vy8587trm86cdp0f1wv", false],
      ["<ulid>", "not-a-ulid", false],
      ["<ulid>", 42, false],
      ["<sha>", SHA_B, true],
      ["<sha>", SHA_B.slice(0, 12), false],
      ["<sha>", SHA_B.toUpperCase(), false],
      ["<iso>", "2026-10-02T18:44:01.123Z", true],
      ["<iso>", "2026-10-02T18:44:01+02:00", true],
      ["<iso>", "2026-10-02", false],
    ];
    for (const [m, value, want] of cases) expect([m, value, ok({ v: "recorded" }, { v: value }, { "/v": m })]).toEqual([m, value, want]);
  });

  test("<any> accepts any value, including objects and arrays, but the field must exist", () => {
    for (const v of [null, 0, "x", [1, 2], { loopOwner: "self", owner: { kind: "watch", pid: 1 } }]) expect(ok({ data: { engine: { loopOwner: "other" } } }, { data: { engine: v } }, { "/data/engine": "<any>" })).toBe(true);
    expect(ok({ data: { engine: {} } }, { data: {} }, { "/data/engine": "<any>" })).toBe(false);
  });

  test("$contains: each listed element matches a distinct actual element (subset rules), others may be present", () => {
    const m: MatchSpec = { "/data/domains": { $contains: ["git"] } };
    expect(ok({ data: { domains: ["git"] } }, { data: { domains: ["index", "git", "queue"] } }, m)).toBe(true);
    expect(ok({ data: { domains: ["git"] } }, { data: { domains: ["index"] } }, m)).toBe(false);
    expect(ok({ data: { domains: ["git"] } }, { data: { domains: "git" } }, m)).toBe(false);
    // objects inside $contains match as subsets
    const checks = [
      { name: "git", status: "ok", detail: "git version 2.43.0" },
      { name: "repo", status: "ok", detail: "/x" },
    ];
    expect(ok({ c: [] }, { c: checks }, { "/c": { $contains: [{ name: "repo", status: "ok" }] } })).toBe(true);
    expect(ok({ c: [] }, { c: checks }, { "/c": { $contains: [{ name: "repo", status: "fail" }] } })).toBe(false);
    // distinct elements: listing one element twice needs it twice
    expect(ok({ c: [] }, { c: ["a", "b"] }, { "/c": { $contains: ["a", "a"] } })).toBe(false);
    expect(ok({ c: [] }, { c: ["a", "b", "a"] }, { "/c": { $contains: ["a", "a"] } })).toBe(true);
    // the assignment backtracks: a greedy first pick would fail here
    const two = [
      { n: "a", s: "ok" },
      { n: "a", s: "fail" },
    ];
    expect(ok({ c: [] }, { c: two }, { "/c": { $contains: [{ n: "a" }, { n: "a", s: "ok" }] } })).toBe(true);
  });

  test("a matcher replaces the comparison at its pointer only; JSON Pointer escapes ~0 and ~1", () => {
    expect(ok({ data: { a: "x", b: "y" } }, { data: { a: "anything", b: "y" } }, { "/data/a": "<any>" })).toBe(true);
    expect(ok({ data: { a: "x", b: "y" } }, { data: { a: "anything", b: "z" } }, { "/data/a": "<any>" })).toBe(false);
    expect(ok({ "a/b": { "c~d": 1 } }, { "a/b": { "c~d": 2 } }, { "/a~1b/c~0d": "<any>" })).toBe(true);
    expect(ok({ list: [{ id: "1" }] }, { list: [{ id: ULID_A }] }, { "/list/0/id": "<ulid>" })).toBe(true);
    expect(resolvePointer({ "a/b": { "c~d": [5] } }, "/a~1b/c~0d/0")).toBe(5);
    expect(resolvePointer({ a: 1 }, "/b")).toBeUndefined();
    expect(resolvePointer({ a: [1] }, "/a/01")).toBeUndefined();
  });
});

describe("substitution and binding", () => {
  test("a <ulid> or <sha> match binds the recorded value to the actual one; later lines see the actual value", () => {
    const subs = new Substitutions();
    expect(matchMessage({ data: { repoId: ULID_A, commitSha: SHA_A } }, { data: { repoId: ULID_B, commitSha: SHA_B } }, { "/data/repoId": "<ulid>", "/data/commitSha": "<sha>" }, subs)).toBeNull();
    expect(subs.get(ULID_A)).toBe(ULID_B);
    expect(subs.get(SHA_A)).toBe(SHA_B);
    // a later exact comparison, and a path containing the id, use the bound value
    expect(ok({ data: { repoId: ULID_A, stateDir: `/home/repos/${ULID_A}` } }, { data: { repoId: ULID_B, stateDir: `/home/repos/${ULID_B}` } }, undefined, subs)).toBe(true);
    expect(ok({ data: { repoId: ULID_A } }, { data: { repoId: ULID_C } }, undefined, subs)).toBe(false);
    // a client message is rewritten the same way
    expect(subs.applyDeep({ params: { sessionId: ULID_A, nested: [`x/${ULID_A}`] } })).toEqual({ params: { sessionId: ULID_B, nested: [`x/${ULID_B}`] } });
  });

  test("a binding is a consistent relation: one recorded value meets one actual value, and vice versa", () => {
    const subs = new Substitutions();
    expect(ok({ a: ULID_A }, { a: ULID_B }, { "/a": "<ulid>" }, subs)).toBe(true);
    // the same recorded id must meet the same actual id, also at a matcher pointer
    expect(matchMessage({ b: ULID_A }, { b: ULID_C }, { "/b": "<ulid>" }, subs)?.reason).toContain("was bound to");
    // two recorded shas that differed must not meet one actual sha
    expect(ok({ main: SHA_A, agent: SHA_B }, { main: "1".repeat(40), agent: "1".repeat(40) }, { "/main": "<sha>", "/agent": "<sha>" }, new Substitutions())).toBe(false);
    // two recorded values that were equal stay equal
    expect(ok({ main: SHA_A, agent: SHA_A }, { main: "1".repeat(40), agent: "2".repeat(40) }, { "/main": "<sha>", "/agent": "<sha>" }, new Substitutions())).toBe(false);
    expect(ok({ main: SHA_A, agent: SHA_A }, { main: "1".repeat(40), agent: "1".repeat(40) }, { "/main": "<sha>", "/agent": "<sha>" }, new Substitutions())).toBe(true);
  });

  test("bindings apply within one message whatever the key order", () => {
    const subs = new Substitutions();
    const expected = { stateDir: `/h/repos/${ULID_A}`, repoId: ULID_A };
    expect(ok(expected, { stateDir: `/h/repos/${ULID_B}`, repoId: ULID_B }, { "/repoId": "<ulid>" }, subs)).toBe(true);
  });

  test("<iso> never binds; a failed match commits no binding", () => {
    const subs = new Substitutions();
    expect(ok({ at: "2026-01-01T00:00:00Z" }, { at: "2026-10-02T00:00:00Z" }, { "/at": "<iso>" }, subs)).toBe(true);
    expect(subs.entries()).toEqual([]);
    expect(ok({ id: ULID_A, x: 1 }, { id: ULID_B, x: 2 }, { "/id": "<ulid>" }, subs)).toBe(false);
    expect(subs.get(ULID_A)).toBeUndefined();
  });

  test("an alias (the header's tmp, a step's URL) rewrites substrings, longest first", () => {
    const subs = new Substitutions();
    subs.alias("/tmp/brain-transcript", "/tmp/brain-rpc-AbC");
    subs.alias("/tmp/brain-transcript/notes", "/elsewhere/notes");
    expect(subs.apply("/tmp/brain-transcript/notes/x and /tmp/brain-transcript/home")).toBe("/elsewhere/notes/x and /tmp/brain-rpc-AbC/home");
    expect(ok({ path: "/tmp/brain-transcript/home" }, { path: "/tmp/brain-rpc-AbC/home" }, undefined, subs)).toBe(true);
    expect(() => subs.alias("/tmp/brain-transcript", "/other")).toThrow("already mapped");
  });
});

describe("lintMatch", () => {
  test("rejects unknown matchers, pointers outside msg, and a msg that fails its own match", () => {
    expect(lintMatch({ a: ULID_A }, { "/a": "<ulid>" })).toBeNull();
    expect(lintMatch({ a: 1 }, { "/a": "<uuid>" })).toContain("not a matcher");
    expect(lintMatch({ a: 1 }, { "/b": "<any>" })).toContain("does not resolve");
    expect(lintMatch({ a: "x" }, { "/a": "<sha>" })).toContain("does not satisfy its own match");
    expect(lintMatch({ a: ["x"] }, { "/a": { $contains: ["y"] } })).toContain("does not satisfy its own match");
    expect(lintMatch({ a: 1 }, ["/a"])).toContain("must be an object");
  });
});
