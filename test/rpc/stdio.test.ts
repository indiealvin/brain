/**
 * `brain rpc --stdio` as a process (protocol §1, §3; design §10): stdout
 * carries protocol lines only, stdin EOF and SIGTERM drain like `shutdown`,
 * keys never reach process.env (so never a git subprocess), never a log line,
 * and `doctor.run`'s live check uses isolated credentials.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatUserConfig } from "../../src/config/userConfig";
import { DEFAULT_MODEL } from "../../src/model/claude";
import { git } from "../harness";
import { CLI, killAllServers, RpcProcess, serverEnv, startOpenRouterStub, type ServerMessage } from "./harness";

const TIMEOUT_MS = 60_000;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  await killAllServers();
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempRoot(): { tmp: string; home: string } {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "brain-rpc-stdio-")));
  const home = join(tmp, "home");
  mkdirSync(home);
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  return { tmp, home };
}

function spawn(env: Record<string, string> = {}): { server: RpcProcess; tmp: string; home: string } {
  const { tmp, home } = tempRoot();
  return { server: RpcProcess.spawn({ home, cwd: tmp, env }), tmp, home };
}

const init = (repoPath: string, env?: Record<string, string>) => ({ protocolVersion: 1, client: { name: "stdio-test", version: "0" }, repoPath, ...(env ? { env } : {}) });
const errorCode = (m: ServerMessage) => (m["error"] as { code: string } | undefined)?.code;

describe("stdout carries protocol lines only", () => {
  test("claimStdio sends every console method and stray stdout writes to stderr, redacted", async () => {
    const script = `
      import { claimStdio } from ${JSON.stringify(resolve(import.meta.dir, "../../src/rpc/stdio.ts"))};
      import { Redactor } from ${JSON.stringify(resolve(import.meta.dir, "../../src/rpc/redact.ts"))};
      const r = new Redactor();
      r.add("sk-test-secret-abcdef");
      const io = claimStdio(r);
      console.log("log sk-test-secret-abcdef");
      console.info("info line");
      console.warn("warn line");
      console.debug("debug line");
      console.dir({ dir: 1 });
      console.table([{ table: 1 }]);
      console.error("error line");
      process.stdout.write("stray stdout write\\n");
      process.stderr.write("stray stderr sk-test-secret-abcdef\\n");
      io.writeLine(JSON.stringify({ type: "x", data: 1 }));
      io.logLine("log line sk-test-secret-abcdef");
      await io.flush();
    `;
    const p = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect(code).toBe(0);
    expect(out).toBe('{"type":"x","data":1}\n');
    for (const want of ["log [redacted]", "info line", "warn line", "debug line", "dir: 1", "table", "error line", "stray stdout write", "stray stderr [redacted]", "log line [redacted]"]) expect(err).toContain(want);
    expect(err).not.toContain("sk-test-secret-abcdef");
  });

  test("`brain rpc` without --stdio is a usage error and starts no server", () => {
    const { home, tmp } = tempRoot();
    const r = Bun.spawnSync([process.execPath, CLI, "rpc"], { cwd: tmp, env: serverEnv(home), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(2);
    expect(r.stdout.toString()).toBe("");
    expect(r.stderr.toString()).toContain("--stdio");
  });
});

describe("drain on stdin EOF and SIGTERM", () => {
  test(
    "stdin EOF drains like shutdown: requests already read finish and send their results, then exit 0",
    async () => {
      const { server, tmp } = spawn();
      server.send({ id: "1", method: "repo.init", params: { path: join(tmp, "notes") } });
      server.send({ id: "2", method: "doctor.run", params: { offline: true, repoPath: join(tmp, "notes") } });
      server.closeStdin();
      expect(await server.finished).toBe(0);
      expect(server.messages.map((m) => [m["id"], m["type"]])).toEqual([
        ["1", "result"],
        ["2", "result"],
      ]);
      expect(server.badLines).toEqual([]);
      expect(server.stderr()).toContain("shutdown (stdin closed)");
    },
    TIMEOUT_MS,
  );

  test(
    "SIGTERM drains: no new requests, the request in flight finishes and is answered, then exit 0",
    async () => {
      const stub = startOpenRouterStub(["/auth/key"]);
      cleanups.push(() => {
        stub.release("/auth/key");
        stub.stop();
      });
      const { server, tmp } = spawn();
      server.send({ id: "d", method: "doctor.run", params: { env: { OPENROUTER_API_KEY: "sk-or-v1-sigterm-test", OPENROUTER_BASE_URL: stub.url, BRAIN_EMBEDDINGS: "hashing" } } });
      while (!stub.requests.includes("/auth/key")) await Bun.sleep(10);
      server.proc.kill("SIGTERM");
      while (!server.stderr().includes("shutdown (SIGTERM)")) await Bun.sleep(10);
      const late = await server.request("late", "repo.init", { path: join(tmp, "notes") });
      expect(errorCode(late)).toBe("SHUTTING_DOWN");
      await Bun.sleep(200);
      expect(server.messages.some((m) => m["id"] === "d")).toBe(false);
      expect(server.exited).toBe(false);
      stub.release("/auth/key");
      expect(await server.finished).toBe(0);
      const d = server.messages.find((m) => m["id"] === "d")!;
      expect(d["type"]).toBe("result");
      expect((d["data"] as { checks: { name: string; status: string }[] }).checks).toContainEqual(expect.objectContaining({ name: "openrouter key", status: "ok" }));
    },
    TIMEOUT_MS,
  );
});

describe("credentials (design §10)", () => {
  test(
    "initialize.env and config.toml keys never reach process.env (a git hook's env), stdout or stderr",
    async () => {
      const PARAM_KEY = "sk-ant-param-secret-2222";
      const CONFIG_KEY = "sk-or-config-secret-1111";
      const { server, tmp, home } = spawn();
      writeFileSync(join(home, "config.toml"), formatUserConfig({ keys: { openrouter: CONFIG_KEY } }), { mode: 0o600 });
      const repo = join(tmp, "notes");
      expect((await server.request("1", "repo.init", { path: repo }))["type"]).toBe("result");
      // Every git subprocess inherits process.env. `git worktree add` (the agent worktree, made by
      // initialize's open sequence) runs post-checkout, which dumps its environment.
      const hooks = join(tmp, "hooks");
      const dump = join(tmp, "hook-env.txt");
      mkdirSync(hooks);
      writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\nenv >> "${dump}"\n`);
      chmodSync(join(hooks, "post-checkout"), 0o755);
      git(repo, "config", "core.hooksPath", hooks);

      const r = await server.request("2", "initialize", init(repo, { ANTHROPIC_API_KEY: PARAM_KEY }));
      expect(r["type"]).toBe("result");
      const d = await server.request("3", "doctor.run", { offline: true });
      const checks = (d["data"] as { checks: { name: string; detail: string }[] }).checks;
      expect(checks.find((c) => c.name === "ANTHROPIC_API_KEY")!.detail).toBe("sk-ant-…2222"); // masked: the private env reached doctor
      server.closeStdin();
      expect(await server.finished).toBe(0);

      expect(existsSync(dump)).toBe(true);
      const hookEnv = readFileSync(dump, "utf8");
      expect(hookEnv).toContain(`BRAIN_HOME=${home}`); // the hook ran under the server
      for (const secret of [PARAM_KEY, CONFIG_KEY]) {
        expect(hookEnv).not.toContain(secret);
        expect(server.stderr()).not.toContain(secret);
        expect(JSON.stringify(server.messages)).not.toContain(secret);
      }
      expect(server.stderr()).toContain("env keys [ANTHROPIC_API_KEY]"); // keys are logged by name only
    },
    TIMEOUT_MS,
  );

  test(
    "doctor.run's live Anthropic check uses isolated credentials: process.env's key is not sent",
    async () => {
      const seen: { path: string; apiKey: string | null; auth: string | null }[] = [];
      const anthropic = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
          seen.push({ path: new URL(req.url).pathname, apiKey: req.headers.get("x-api-key"), auth: req.headers.get("authorization") });
          return Response.json({ type: "model", id: DEFAULT_MODEL, display_name: "Claude", created_at: "2026-01-01T00:00:00Z" });
        },
      });
      cleanups.push(() => void anthropic.stop(true));
      // The server's own environment has a key; the client's env blanks it and brings a token.
      // Without isolation the SDK would fall back to process.env's key and send it.
      const { server } = spawn({ ANTHROPIC_API_KEY: "sk-ant-process-env-3333" });
      const d = await server.request("1", "doctor.run", {
        env: { BRAIN_MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "private-token-4444", ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropic.port}` },
      });
      const checks = (d["data"] as { checks: { name: string; status: string }[] }).checks;
      expect(checks).toContainEqual(expect.objectContaining({ name: "anthropic model", status: "ok" }));
      expect(seen).toEqual([{ path: `/v1/models/${DEFAULT_MODEL}`, apiKey: null, auth: "Bearer private-token-4444" }]);
      expect(server.stderr()).not.toContain("private-token-4444");
    },
    TIMEOUT_MS,
  );
});
