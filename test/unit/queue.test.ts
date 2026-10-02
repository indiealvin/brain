import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openQueue, type Queue } from "../../src/core/queue";
import type { Mutation } from "../../src/core/types";

let dir: string;
let q: Queue;

function mut(id: string, extra: Partial<Mutation> = {}): Mutation {
  return {
    mutationId: id,
    type: "ENRICH",
    summary: `enrich ${id}`,
    targets: [{ kind: "present", noteId: "n1", path: "knowledge/x.md", blobHash: "abc" }],
    writes: [{ path: "knowledge/x.md", content: "# X\n" }],
    dependsOn: [],
    evidence: ["conversation://s/1"],
    ...extra,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-queue-unit-"));
  q = openQueue(join(dir, "sub", "queue.sqlite"));
});

afterEach(() => {
  q.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("queue", () => {
  test("creates the §11 table shape and WAL mode", () => {
    q.close();
    const db = new Database(join(dir, "sub", "queue.sqlite"));
    const cols = (db.query("PRAGMA table_info(mutations)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual([
      "mutation_id",
      "seq",
      "state",
      "type",
      "summary",
      "targets_json",
      "writes_json",
      "depends_on_json",
      "replans",
      "evidence_json",
      "reasoning",
      "attempt_count",
      "last_error",
      "commit_sha",
      "created_at",
      "updated_at",
    ]);
    const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(mode.journal_mode).toBe("wal");
    db.close();
    q = openQueue(join(dir, "sub", "queue.sqlite"));
  });

  test("enqueue assigns increasing seq, starts QUEUED, is idempotent by id", () => {
    q.enqueue(mut("mut_a"));
    q.enqueue(mut("mut_b", { replans: "mut_0", reasoning: "why" }));
    q.enqueue(mut("mut_a", { summary: "changed" }));
    const rows = q.list();
    expect(rows.map((r) => r.mutationId)).toEqual(["mut_a", "mut_b"]);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(rows.every((r) => r.state === "QUEUED")).toBe(true);
    expect(rows[0]!.attemptCount).toBe(0);
    expect(rows[0]!.replans).toBeUndefined();
    expect(rows[0]!.lastError).toBeUndefined();
    expect(rows[0]!.commitSha).toBeUndefined();
    expect(rows[1]!.replans).toBe("mut_0");
    expect(q.getMutation("mut_a")?.summary).toBe("enrich mut_a");
  });

  test("getMutation materializes writes, targets, evidence and reasoning", () => {
    const m = mut("mut_c", { reasoning: "because", dependsOn: ["mut_a"], writes: [{ path: "knowledge/y.md", content: null }] });
    q.enqueue(m);
    expect(q.getMutation("mut_c")).toEqual(m);
    expect(q.getMutation("nope")).toBeUndefined();
    expect(q.get("nope")).toBeUndefined();
    const r = q.getMutation("mut_a");
    expect(r).toBeUndefined();
  });

  test("setState patches lastError / commitSha / attempt_count and updates updated_at", async () => {
    q.enqueue(mut("mut_d"));
    const before = q.get("mut_d")!;
    q.setState("mut_d", "RUNNING", { attemptInc: 1 });
    q.setState("mut_d", "RUNNING", { attemptInc: 1 });
    let row = q.get("mut_d")!;
    expect(row.state).toBe("RUNNING");
    expect(row.attemptCount).toBe(2);
    q.setState("mut_d", "FAILED", { lastError: "BOOM: x" });
    row = q.get("mut_d")!;
    expect(row.lastError).toBe("BOOM: x");
    q.setState("mut_d", "COMMITTED", { commitSha: "deadbeef", lastError: null });
    row = q.get("mut_d")!;
    expect(row.commitSha).toBe("deadbeef");
    expect(row.lastError).toBeUndefined();
    expect(row.attemptCount).toBe(2);
    expect(row.createdAt).toBe(before.createdAt);
    expect(row.updatedAt >= before.updatedAt).toBe(true);
    expect(() => q.setState("missing", "REPLAN")).toThrow(/unknown mutation/);
  });

  test("listByState filters and keeps seq order", () => {
    q.enqueue(mut("mut_1"));
    q.enqueue(mut("mut_2"));
    q.enqueue(mut("mut_3"));
    q.setState("mut_1", "COMMITTED");
    q.setState("mut_3", "RUNNING");
    expect(q.listByState(["COMMITTED", "RUNNING"]).map((r) => r.mutationId)).toEqual(["mut_1", "mut_3"]);
    expect(q.listByState(["QUEUED"]).map((r) => r.mutationId)).toEqual(["mut_2"]);
    expect(q.listByState([])).toEqual([]);
  });

  test("state survives reopen", () => {
    q.enqueue(mut("mut_p"));
    q.setState("mut_p", "REPLAN", { lastError: "PRECONDITION_FAILED: x" });
    q.close();
    q = openQueue(join(dir, "sub", "queue.sqlite"));
    const row = q.get("mut_p")!;
    expect(row.state).toBe("REPLAN");
    expect(row.lastError).toBe("PRECONDITION_FAILED: x");
  });
});

describe("enqueue across processes (CR-1)", () => {
  const QUEUE_MODULE = join(import.meta.dir, "..", "..", "src", "core", "queue.ts");
  const PER_PROCESS = 150;

  /** A child that opens the queue, prints READY, waits for `go`, then enqueues PER_PROCESS mutations as fast as it can. */
  function enqueuer(dbPath: string, go: string, prefix: string): string {
    return `
      const { existsSync } = await import("node:fs");
      const { openQueue } = await import(${JSON.stringify(QUEUE_MODULE)});
      const q = openQueue(${JSON.stringify(dbPath)});
      console.log("READY");
      while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 2));
      const errors = [];
      for (let i = 0; i < ${PER_PROCESS}; i++) {
        const id = ${JSON.stringify(prefix)} + String(i).padStart(4, "0");
        try {
          q.enqueue({ mutationId: id, type: "CREATE", summary: id, targets: [{ kind: "absent", slug: id }], writes: [], dependsOn: [], evidence: [] });
        } catch (e) {
          errors.push(String((e && e.code) || e));
        }
      }
      q.close();
      console.log("ERRORS " + errors.length + " " + JSON.stringify([...new Set(errors)]));
    `;
  }

  function spawnEnqueuer(script: string) {
    const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit", stdin: "ignore" });
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let eof = false;
    const readUntil = async (text: string) => {
      while (!buf.includes(text) && !eof) {
        const r = await reader.read();
        if (r.done) eof = true;
        else buf += decoder.decode(r.value, { stream: true });
      }
      return buf;
    };
    return { proc, readUntil, readAll: async () => (await readUntil("\u0000never")) };
  }

  test(
    "two processes enqueueing at once both succeed: every row lands once, with consecutive seq numbers",
    async () => {
      const dbPath = join(dir, "sub", "queue.sqlite");
      const go = join(dir, "go");
      const kids = ["mut_a", "mut_b"].map((prefix) => spawnEnqueuer(enqueuer(dbPath, go, prefix)));
      try {
        // Both children have the queue open before either starts writing.
        for (const k of kids) expect(await k.readUntil("READY")).toContain("READY");
        await Bun.write(go, "");
        const outs = await Promise.all(kids.map((k) => k.readAll()));
        expect(await Promise.all(kids.map((k) => k.proc.exited))).toEqual([0, 0]);
        expect(outs.map((o) => o.split("\n").find((l) => l.startsWith("ERRORS ")))).toEqual(["ERRORS 0 []", "ERRORS 0 []"]);
      } finally {
        for (const k of kids) {
          try {
            k.proc.kill("SIGKILL");
          } catch {}
        }
      }
      const rows = q.list();
      expect(rows.length).toBe(2 * PER_PROCESS);
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 2 * PER_PROCESS }, (_, i) => i + 1));
      expect(new Set(rows.map((r) => r.mutationId)).size).toBe(2 * PER_PROCESS);
    },
    60_000,
  );
});
