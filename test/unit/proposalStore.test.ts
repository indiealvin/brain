import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProposalStore, type ProposalStore } from "../../src/proposal/store";
import type { Proposal } from "../../src/core/types";

let dir: string;
let dbPath: string;
let store: ProposalStore;

function prop(id: string, extra: Partial<Proposal> = {}): Proposal {
  return {
    proposalId: id,
    mutationId: `mut_${id}`,
    operation: "MERGE",
    targets: [
      { noteId: "n1", path: "knowledge/a.md", blobHash: "aaa" },
      { noteId: "n2", path: "knowledge/b.md", blobHash: "bbb" },
    ],
    writes: [
      { path: "knowledge/a.md", content: "# A\n" },
      { path: "knowledge/b.md", content: null },
    ],
    evidence: ["conversation://s/1"],
    reasoning: "merge b into a",
    createdAt: `2026-09-28T00:00:0${id.slice(-1)}.000Z`,
    status: "PENDING",
    ...extra,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-proposals-unit-"));
  dbPath = join(dir, "sub", "proposals.sqlite");
  store = openProposalStore(dbPath, { now: () => "2026-09-29T00:00:00.000Z" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("proposal store", () => {
  test("creates the §51 table shape, a status index, and WAL mode", () => {
    store.close();
    const db = new Database(dbPath);
    const cols = (db.query("PRAGMA table_info(proposals)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      "proposal_id",
      "mutation_id",
      "operation",
      "targets_json",
      "writes_json",
      "evidence_json",
      "reasoning",
      "created_at",
      "status",
      "resolved_at",
      "decision_note",
    ]);
    const idx = (db.query("PRAGMA index_list(proposals)").all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain("proposals_status");
    expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    db.close();
    store = openProposalStore(dbPath);
  });

  test("create is idempotent by id and round-trips every field (writes may delete)", () => {
    const p = prop("p1");
    store.create(p);
    store.create({ ...p, reasoning: "changed" });
    const got = store.get("p1")!;
    expect(got).toEqual(p);
    expect(got.writes[1]!.content).toBeNull();
    expect(got.resolvedAt).toBeUndefined();
    expect(got.decisionNote).toBeUndefined();
    expect(store.get("nope")).toBeUndefined();
    expect(store.list()).toHaveLength(1);
  });

  test("list orders by created_at and filters by status", () => {
    store.create(prop("p2"));
    store.create(prop("p1"));
    store.create(prop("p3"));
    expect(store.list().map((p) => p.proposalId)).toEqual(["p1", "p2", "p3"]);
    store.decide("p2", "REJECTED", { decisionNote: "no" });
    expect(store.list("PENDING").map((p) => p.proposalId)).toEqual(["p1", "p3"]);
    expect(store.list("REJECTED").map((p) => p.proposalId)).toEqual(["p2"]);
    expect(store.list("ACCEPTED")).toEqual([]);
  });

  test("decide sets status/resolvedAt/decisionNote; ACCEPTED may later become STALE; unknown id throws", () => {
    store.create(prop("p1"));
    store.decide("p1", "REJECTED", { decisionNote: "distinct ideas" });
    let got = store.get("p1")!;
    expect(got.status).toBe("REJECTED");
    expect(got.decisionNote).toBe("distinct ideas");
    expect(got.resolvedAt).toBe("2026-09-29T00:00:00.000Z");

    store.create(prop("p2"));
    store.decide("p2", "ACCEPTED", { resolvedAt: "2026-09-29T01:00:00.000Z" });
    expect(store.get("p2")!.resolvedAt).toBe("2026-09-29T01:00:00.000Z");
    store.decide("p2", "STALE");
    got = store.get("p2")!;
    expect(got.status).toBe("STALE");
    expect(got.decisionNote).toBeUndefined();

    expect(() => store.decide("nope", "STALE")).toThrow(/unknown proposal/);
  });

  test("refreshStaleness marks PENDING proposals whose target blob changed or vanished (I-19)", () => {
    store.create(prop("p1")); // untouched
    store.create(prop("p2", { targets: [{ noteId: "n1", path: "knowledge/a.md", blobHash: "OLD" }] })); // changed
    store.create(prop("p3", { targets: [{ noteId: "n3", path: "knowledge/gone.md", blobHash: "ccc" }] })); // missing
    store.create(prop("p4", { targets: [{ noteId: "n1", path: "knowledge/a.md", blobHash: "OLD" }] }));
    store.decide("p4", "REJECTED"); // not PENDING: never re-evaluated
    const blobs: Record<string, string> = { "knowledge/a.md": "aaa", "knowledge/b.md": "bbb" };
    const marked = store.refreshStaleness((path) => blobs[path] ?? null);
    expect(marked.sort()).toEqual(["p2", "p3"]);
    expect(store.get("p1")!.status).toBe("PENDING");
    expect(store.get("p2")!.status).toBe("STALE");
    expect(store.get("p2")!.resolvedAt).toBe("2026-09-29T00:00:00.000Z");
    expect(store.get("p3")!.status).toBe("STALE");
    expect(store.get("p4")!.status).toBe("REJECTED");
    expect(store.refreshStaleness((path) => blobs[path] ?? null)).toEqual([]);
  });

  test("negativeEvidenceFor returns only REJECTED proposals touching the notes, oldest first (I-20)", () => {
    store.create(prop("p3", { targets: [{ noteId: "n2", path: "knowledge/b.md", blobHash: "bbb" }] }));
    store.create(prop("p1"));
    store.create(prop("p2", { targets: [{ noteId: "n9", path: "knowledge/z.md", blobHash: "zzz" }] }));
    store.create(prop("p4")); // stays PENDING
    store.decide("p1", "REJECTED", { decisionNote: "a" });
    store.decide("p2", "REJECTED", { decisionNote: "b" });
    store.decide("p3", "REJECTED", { decisionNote: "c" });
    expect(store.negativeEvidenceFor(["n2"]).map((p) => p.proposalId)).toEqual(["p1", "p3"]);
    expect(store.negativeEvidenceFor(["n1"]).map((p) => p.proposalId)).toEqual(["p1"]);
    expect(store.negativeEvidenceFor(["n9", "n2"]).map((p) => p.proposalId)).toEqual(["p1", "p2", "p3"]);
    expect(store.negativeEvidenceFor(["none"])).toEqual([]);
    expect(store.negativeEvidenceFor([])).toEqual([]);
  });

  test("state persists across close and reopen", () => {
    store.create(prop("p1"));
    store.decide("p1", "REJECTED", { decisionNote: "keep me" });
    store.close();
    store = openProposalStore(dbPath);
    const got = store.get("p1")!;
    expect(got.status).toBe("REJECTED");
    expect(got.decisionNote).toBe("keep me");
    expect(got.writes).toEqual(prop("p1").writes);
  });
});
