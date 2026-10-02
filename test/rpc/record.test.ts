/**
 * The transcript recorder (harness/record.ts): a recorded live session
 * replays against a fresh server, with `{{ref:…}}` values resolved, temp paths
 * written in recorded form, and matchers proposed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { killAllServers } from "./harness";
import { autoMatch, recordTranscript } from "./harness/record";
import { createRun, replay } from "./harness/replay";
import { parseTranscript, type C2sLine, type S2cLine } from "./harness/transcript";

afterEach(killAllServers);

const lines = (...l: object[]) => l.map((x) => JSON.stringify(x)).join("\n");

describe("recorder", () => {
  test(
    "records a session that replays; refs resolve to earlier results; paths are written under the recorded tmp",
    async () => {
      const input = lines(
        { asserts: { notifications: [] } },
        { dir: "c2s", msg: { id: "1", method: "repo.init", params: { path: "/tmp/brain-transcript/notes" } } },
        { dir: "c2s", msg: { id: "2", method: "initialize", params: { protocolVersion: 1, client: { name: "rec", version: "0" }, repoPath: "{{ref:1/path}}" } } },
        { dir: "s2c", msg: { id: "ignored", type: "result", data: {} } },
        { dir: "c2s", msg: { id: "3", method: "no.such.method", params: { repoId: "{{ref:2/repoId}}" } } },
        { dir: "c2s", msg: { id: "4", method: "shutdown", params: {} } },
      );
      const text = await recordTranscript(input, { baseDir: import.meta.dir, settleMs: 150 });
      const t = parseTranscript(text, "recorded");
      expect(t.header).toEqual({ asserts: { notifications: [] }, tmp: "/tmp/brain-transcript" });
      const c2s = t.lines.filter((l): l is C2sLine => l.dir === "c2s");
      const s2c = t.lines.filter((l): l is S2cLine => l.dir === "s2c");
      expect(c2s.map((l) => l.msg["id"])).toEqual(["1", "2", "3", "4"]);
      expect((c2s[1]!.msg["params"] as Record<string, unknown>)["repoPath"]).toBe("/tmp/brain-transcript/notes");
      const repoId = (s2c[0]!.msg["data"] as Record<string, unknown>)["repoId"];
      expect((c2s[2]!.msg["params"] as Record<string, unknown>)["repoId"]).toBe(repoId as string);
      expect(s2c.map((l) => [l.msg["id"], l.msg["type"]])).toEqual([
        ["1", "result"],
        ["2", "result"],
        ["3", "error"],
        ["4", "result"],
      ]);
      expect(s2c[0]!.match).toEqual({ "/data/repoId": "<ulid>", "/data/commitSha": "<sha>" });
      expect(s2c[1]!.match).toEqual({ "/data/engine": "<any>", "/data/brainVersion": "<any>", "/data/repoId": "<ulid>" });
      expect(s2c[2]!.match).toEqual({ "/error/message": "<any>" });
      expect(text).not.toContain("brain-rpc-"); // no real temp path leaks into the transcript

      const run = createRun(t.header, import.meta.dir);
      try {
        await replay(t, run);
      } finally {
        await run.dispose();
      }
    },
    60_000,
  );

  test("autoMatch: forms, staging and machine-specific values, repo.changed domains", () => {
    expect(autoMatch({ type: "repo.changed", data: { domains: ["git", "index"], mainHead: "a".repeat(40), at: "2026-10-02T10:00:00.000Z" } }, undefined)).toEqual({
      "/data/domains": { $contains: ["git", "index"] },
      "/data/mainHead": "<sha>",
      "/data/at": "<iso>",
    });
    expect(autoMatch({ id: "1", type: "result", data: { checks: [{ detail: "01M3YYVXW2YZWXMC5XA0VFBQ7Z" }], ok: true } }, "doctor.run")).toEqual({ "/data/checks": "<any>" });
  });
});
