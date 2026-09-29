import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRepoWorktreeLock, lockPath } from "../../src/sync/lock";

const LOCK_MODULE = join(import.meta.dir, "..", "..", "src", "sync", "lock.ts");
let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("RepoWorktreeLock", () => {
  test("cross-process: waits for a child process that holds the lock", async () => {
    dir = mkdtempSync(join(tmpdir(), "brain-lock-"));
    const script = `
      const { withRepoWorktreeLock } = await import(${JSON.stringify(LOCK_MODULE)});
      await withRepoWorktreeLock(${JSON.stringify(dir)}, async () => {
        console.log("held");
        await new Promise((r) => setTimeout(r, 300));
      });
    `;
    const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "inherit" });
    // wait until the child reports it holds the lock
    const reader = child.stdout.getReader();
    let seen = "";
    while (!seen.includes("held")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    expect(seen).toContain("held");
    expect(existsSync(lockPath(dir))).toBe(true);
    const t0 = Date.now();
    const v = await withRepoWorktreeLock(dir, async () => "parent");
    const elapsed = Date.now() - t0;
    expect(v).toBe("parent");
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(await child.exited).toBe(0);
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  test("a lock left by a dead process is taken over", async () => {
    dir = mkdtempSync(join(tmpdir(), "brain-lock-"));
    // a pid that cannot be alive (max pid on Linux is < 2^22)
    writeFileSync(lockPath(dir), `4194304 ${Date.now()}\n`);
    const t0 = Date.now();
    expect(await withRepoWorktreeLock(dir, async () => 1)).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  test("a lock older than 60 s is stale even when its pid is alive", async () => {
    dir = mkdtempSync(join(tmpdir(), "brain-lock-"));
    writeFileSync(lockPath(dir), `${process.pid} ${Date.now() - 120_000}\n`);
    expect(await withRepoWorktreeLock(dir, async () => 2)).toBe(2);
    expect(existsSync(lockPath(dir))).toBe(false);
  });

  test("many in-process contenders run strictly one at a time", async () => {
    dir = mkdtempSync(join(tmpdir(), "brain-lock-"));
    let inside = 0;
    let maxInside = 0;
    const jobs = Array.from({ length: 6 }, (_, i) =>
      withRepoWorktreeLock(dir, async () => {
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await new Promise((r) => setTimeout(r, 15));
        inside -= 1;
        return i;
      }),
    );
    expect((await Promise.all(jobs)).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxInside).toBe(1);
  });
});
