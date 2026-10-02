import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatDoctorReport, parseGitVersion, runDoctor, type DoctorCheck } from "../../src/config/doctor";
import { applyUserConfigToEnv, formatUserConfig, loadUserConfig, maskKey, saveUserConfig, userConfigPath, type UserConfig } from "../../src/config/userConfig";
import { createEmbeddingProvider, defaultEmbeddingsKind, OpenRouterEmbeddingProvider } from "../../src/model";
import type { FetchLike } from "../../src/model/openrouter";

let home: string;
let prevHome: string | undefined;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "brain-userconfig-"));
  prevHome = process.env.BRAIN_HOME;
  process.env.BRAIN_HOME = home;
});
afterAll(() => {
  if (prevHome === undefined) delete process.env.BRAIN_HOME;
  else process.env.BRAIN_HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

const FULL: UserConfig = {
  model: { provider: "openrouter", model: "anthropic/claude-sonnet-4.5", effort: "medium" },
  keys: { openrouter: "sk-or-v1-0123456789abcdef", anthropic: "sk-ant-api03-zzzzzzzzzz" },
  embeddings: { provider: "openrouter", model: "openai/text-embedding-3-small", dims: 1536 },
};

describe("user config ($BRAIN_HOME/config.toml)", () => {
  test("userConfigPath lives under BRAIN_HOME, never inside a repo", () => {
    expect(userConfigPath()).toBe(join(home, "config.toml"));
  });

  test("round-trips through TOML and is written with mode 0600 (mkdir -p, existing mode fixed)", () => {
    const path = join(home, "nested", "dir", "config.toml");
    expect(saveUserConfig(FULL, { path })).toBe(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadUserConfig({ path })).toEqual(FULL);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("[model]");
    expect(text).toContain("[keys]");
    expect(text).toContain("[embeddings]");
    expect(text).toContain("dims = 1536");

    // an existing world-readable file is tightened on rewrite
    chmodSync(path, 0o644);
    saveUserConfig({ ...FULL, model: { provider: "anthropic" } }, { path });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadUserConfig({ path })?.model).toEqual({ provider: "anthropic" });

    // default path is under BRAIN_HOME
    const dflt = saveUserConfig(FULL);
    expect(dflt).toBe(join(home, "config.toml"));
    expect(loadUserConfig()).toEqual(FULL);
  });

  test("formatUserConfig omits undefined leaves and empty sections", () => {
    const text = formatUserConfig({ model: { provider: "openrouter", model: undefined }, keys: {}, embeddings: { provider: "hashing" } });
    expect(text).toContain('provider = "openrouter"');
    expect(text).not.toContain("[keys]");
    expect(text).not.toContain("model =");
    expect(text).toContain("[embeddings]");
  });

  test("partial files load what is present and apply only those variables", () => {
    const path = join(home, "partial.toml");
    writeFileSync(path, '[keys]\nopenrouter = "sk-or-v1-partialkey0000"\n');
    const cfg = loadUserConfig({ path });
    expect(cfg).toEqual({ keys: { openrouter: "sk-or-v1-partialkey0000" } });
    const env: NodeJS.ProcessEnv = {};
    applyUserConfigToEnv(cfg, env);
    expect(env).toEqual({ OPENROUTER_API_KEY: "sk-or-v1-partialkey0000" });
  });

  test("environment always wins over the file (blank counts as unset)", () => {
    const env: NodeJS.ProcessEnv = { BRAIN_MODEL: "custom/model", OPENROUTER_API_KEY: "sk-or-from-env-1234", BRAIN_EMBEDDING_DIMS: "  " };
    applyUserConfigToEnv(FULL, env);
    expect(env["BRAIN_MODEL"]).toBe("custom/model");
    expect(env["OPENROUTER_API_KEY"]).toBe("sk-or-from-env-1234");
    expect(env["BRAIN_MODEL_PROVIDER"]).toBe("openrouter");
    expect(env["BRAIN_EFFORT"]).toBe("medium");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-ant-api03-zzzzzzzzzz");
    expect(env["BRAIN_EMBEDDINGS"]).toBe("openrouter");
    expect(env["BRAIN_EMBEDDING_MODEL"]).toBe("openai/text-embedding-3-small");
    expect(env["BRAIN_EMBEDDING_DIMS"]).toBe("1536");
    // null config is a no-op
    const untouched: NodeJS.ProcessEnv = { X: "1" };
    expect(applyUserConfigToEnv(null, untouched)).toEqual({ X: "1" });
  });

  test("missing file → null silently; malformed file → null with a warning, never a throw", () => {
    expect(loadUserConfig({ path: join(home, "does-not-exist.toml"), warn: () => {} })).toBeNull();
    const bad = join(home, "bad.toml");
    writeFileSync(bad, "[model\nprovider = openrouter\n");
    const warnings: string[] = [];
    expect(loadUserConfig({ path: bad, warn: (m) => warnings.push(m) })).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("malformed");
    expect(warnings[0]).toContain("brain setup");
  });

  test("ill-typed values are dropped with a warning; unknown keys ignored", () => {
    const path = join(home, "odd.toml");
    writeFileSync(path, '[model]\nprovider = "gpt"\nmodel = "x"\nextra = 1\n[embeddings]\nprovider = "openrouter"\ndims = "lots"\n[other]\nk = 1\n');
    const warnings: string[] = [];
    const cfg = loadUserConfig({ path, warn: (m) => warnings.push(m) });
    expect(cfg).toEqual({ model: { model: "x" }, embeddings: { provider: "openrouter" } });
    expect(warnings.some((w) => w.includes("model.provider"))).toBe(true);
    expect(warnings.some((w) => w.includes("embeddings.dims"))).toBe(true);
  });

  test("maskKey keeps the vendor prefix and last four characters only", () => {
    expect(maskKey("sk-or-v1-0123456789abcd")).toBe("sk-or-…abcd");
    expect(maskKey("sk-ant-api03-xxxxxxxxxxxxWXYZ")).toBe("sk-ant-…WXYZ");
    expect(maskKey("sk-or-x")).toBe("sk-or-…"); // too short to reveal a suffix
    expect(maskKey("plainkeyvalue123")).toBe("pla…e123");
    expect(maskKey(undefined)).toBe("(none)");
    expect(maskKey("")).toBe("(none)");
  });
});

describe("embeddings default follows the model provider", () => {
  test("openrouter provider → openrouter embeddings; anthropic (or nothing) → hashing; explicit wins", () => {
    expect(defaultEmbeddingsKind({ OPENROUTER_API_KEY: "o" })).toBe("openrouter");
    expect(defaultEmbeddingsKind({ BRAIN_MODEL_PROVIDER: "openrouter" })).toBe("openrouter");
    expect(defaultEmbeddingsKind({ ANTHROPIC_API_KEY: "a" })).toBe("hashing");
    expect(defaultEmbeddingsKind({ OPENROUTER_API_KEY: "o", ANTHROPIC_API_KEY: "a" })).toBe("hashing");
    expect(defaultEmbeddingsKind({})).toBe("hashing");
    expect(defaultEmbeddingsKind({ BRAIN_MODEL_PROVIDER: "bogus" })).toBe("hashing"); // reported by the model factory, not here
    const e = createEmbeddingProvider({ OPENROUTER_API_KEY: "o" });
    expect(e).toBeInstanceOf(OpenRouterEmbeddingProvider);
    expect(e.dims).toBe(1536);
    expect(createEmbeddingProvider({ OPENROUTER_API_KEY: "o", BRAIN_EMBEDDINGS: "hashing" }).model).toBe("hashing-v1");
    expect(createEmbeddingProvider({ ANTHROPIC_API_KEY: "a" }).model).toBe("hashing-v1");
  });
});

// ---------------------------------------------------------------------------
// doctor with injected fetch / model lookup (no network)
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fake OpenRouter: `/models` lists `models`; `/embeddings` returns `dims`-sized vectors. */
function fakeOpenRouter(opts: { models?: string[]; dims?: number; status?: number } = {}): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (input: string, init: RequestInit) => {
    calls.push(`${init.method} ${input}`);
    const auth = (init.headers as Record<string, string>)["Authorization"];
    const authed = auth?.startsWith("Bearer sk-or-") === true;
    if (opts.status) return jsonResponse(opts.status, { error: { message: "boom" } });
    // like the real API: /models is public, /auth/key and /embeddings need a valid key
    if (input.endsWith("/models")) return jsonResponse(200, { data: (opts.models ?? ["anthropic/claude-sonnet-4.5"]).map((id) => ({ id })) });
    if (!authed) return jsonResponse(401, { error: { message: "no auth" } });
    if (input.endsWith("/auth/key")) return jsonResponse(200, { data: { label: "test key" } });
    if (input.endsWith("/embeddings")) {
      const body = JSON.parse(String(init.body));
      return jsonResponse(200, { data: body.input.map((_: string, i: number) => ({ index: i, embedding: new Array(opts.dims ?? 1536).fill(0.1) })) });
    }
    return jsonResponse(404, {});
  }) as FetchLike & { calls: string[] };
  f.calls = calls;
  return f;
}

const byName = (checks: DoctorCheck[], name: string) => checks.find((c) => c.name === name)!;
const gitOk = () => "git version 2.43.0";

describe("brain doctor (in-process, injected fetch)", () => {
  const OR_ENV = { OPENROUTER_API_KEY: "sk-or-v1-doctortest1234", BRAIN_MODEL: "anthropic/claude-sonnet-4.5" };

  test("all green: /models lists the model and /embeddings returns the configured dims", async () => {
    const fetch = fakeOpenRouter();
    const r = await runDoctor({ env: OR_ENV, fetch, gitVersion: gitOk, repoRoot: null });
    expect(r.ok).toBe(true);
    expect(byName(r.checks, "OPENROUTER_API_KEY").detail).toBe("sk-or-…1234");
    expect(byName(r.checks, "openrouter key").detail).toBe("accepted (test key)");
    expect(byName(r.checks, "openrouter model").status).toBe("ok");
    expect(byName(r.checks, "openrouter embeddings").status).toBe("ok");
    expect(fetch.calls).toEqual(["GET https://openrouter.ai/api/v1/auth/key", "GET https://openrouter.ai/api/v1/models", "POST https://openrouter.ai/api/v1/embeddings"]);
    const text = formatDoctorReport(r);
    expect(text).toContain("all required checks passed");
    expect(text).not.toContain("doctortest1234");
  });

  test("bad model id → required failure naming the fix", async () => {
    const r = await runDoctor({ env: { ...OR_ENV, BRAIN_MODEL: "nope/model" }, fetch: fakeOpenRouter(), gitVersion: gitOk, repoRoot: null });
    expect(r.ok).toBe(false);
    const c = byName(r.checks, "openrouter model");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("nope/model");
    expect(c.detail).toContain("brain setup --model");
  });

  test("dims mismatch → reports the actual size and the exact `brain setup --dims <n>` fix", async () => {
    const r = await runDoctor({ env: { ...OR_ENV, BRAIN_EMBEDDING_DIMS: "1536" }, fetch: fakeOpenRouter({ dims: 3072 }), gitVersion: gitOk, repoRoot: null });
    expect(r.ok).toBe(false);
    const c = byName(r.checks, "openrouter embeddings");
    expect(c.status).toBe("fail");
    expect(c.detail).toContain("returns 3072 dims");
    expect(c.detail).toContain("brain setup --dims 3072");
  });

  test("rejected key → auth failure; hashing embeddings skip the /embeddings call", async () => {
    const fetch = fakeOpenRouter();
    const r = await runDoctor({ env: { OPENROUTER_API_KEY: "bad-key-value-1234", BRAIN_EMBEDDINGS: "hashing" }, fetch, gitVersion: gitOk, repoRoot: null });
    expect(r.ok).toBe(false);
    expect(byName(r.checks, "openrouter key").status).toBe("fail");
    expect(byName(r.checks, "openrouter key").detail).toContain("401");
    expect(byName(r.checks, "openrouter model").status).toBe("ok"); // /models is public
    expect(fetch.calls).toHaveLength(2);
    expect(byName(r.checks, "embeddings").detail).toContain("hashing");
  });

  test("--offline skips live checks; no key at all is a required failure pointing at brain setup", async () => {
    const fetch = fakeOpenRouter();
    const ok = await runDoctor({ env: OR_ENV, fetch, gitVersion: gitOk, offline: true, repoRoot: null });
    expect(ok.ok).toBe(true);
    expect(byName(ok.checks, "live check").status).toBe("skip");
    expect(fetch.calls).toHaveLength(0);

    const none = await runDoctor({ env: {}, fetch, gitVersion: gitOk, offline: true, repoRoot: null, configPath: join(home, "absent.toml") });
    expect(none.ok).toBe(false);
    expect(byName(none.checks, "ANTHROPIC_API_KEY").status).toBe("fail");
    expect(byName(none.checks, "ANTHROPIC_API_KEY").detail).toContain("brain setup");
    expect(byName(none.checks, "config").detail).toContain("run `brain setup`");
  });

  test("anthropic: models.retrieve success / not-found / auth errors are reported clearly", async () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-api03-doctor0000WXYZ", BRAIN_MODEL: "claude-opus-5-5" };
    const seen: string[] = [];
    const ok = await runDoctor({ env, gitVersion: gitOk, repoRoot: null, retrieveModel: async (m) => void seen.push(m) });
    expect(ok.ok).toBe(true);
    expect(seen).toEqual(["claude-opus-5-5"]);
    expect(byName(ok.checks, "ANTHROPIC_API_KEY").detail).toBe("sk-ant-…WXYZ");
    expect(byName(ok.checks, "embeddings").detail).toContain("no embeddings endpoint");
    expect(byName(ok.checks, "embeddings").detail).toContain("--embeddings openrouter");

    const missing = await runDoctor({
      env,
      gitVersion: gitOk,
      repoRoot: null,
      retrieveModel: async () => {
        throw new Error("404 model not found");
      },
    });
    expect(missing.ok).toBe(false);
    expect(byName(missing.checks, "anthropic model").detail).toContain("claude-opus-5-5: 404 model not found");
  });

  test("git older than 2.39 or missing is a required failure; Apple's 2.39.5 passes; BRAIN_HOME is created and checked", async () => {
    const old = await runDoctor({ env: OR_ENV, offline: true, repoRoot: null, gitVersion: () => "git version 2.38.5" });
    expect(old.ok).toBe(false);
    expect(byName(old.checks, "git").status).toBe("fail");
    expect(byName(old.checks, "git").detail).toContain("older than 2.39");
    for (const v of ["git version 2.39.5 (Apple Git-154)", "git version 2.39.5"]) {
      const floor = await runDoctor({ env: OR_ENV, offline: true, repoRoot: null, gitVersion: () => v });
      expect(byName(floor.checks, "git").status).toBe("ok");
      expect(byName(floor.checks, "git").detail).toBe(v);
    }
    const none = await runDoctor({ env: OR_ENV, offline: true, repoRoot: null, gitVersion: () => null });
    expect(byName(none.checks, "git").status).toBe("fail");
    expect(byName(none.checks, "git").detail).toContain("need ≥ 2.39");
    expect(byName(none.checks, "BRAIN_HOME").status).toBe("ok");
    expect(byName(none.checks, "BRAIN_HOME").detail).toContain(home);
    expect(parseGitVersion("git version 2.43.0")).toEqual([2, 43, 0]);
    expect(parseGitVersion("git version 2.39.5 (Apple Git-154)")).toEqual([2, 39, 5]);
    expect(parseGitVersion("nonsense")).toBeNull();
  });

  test("an unwritable BRAIN_HOME is a required failure", async () => {
    if (process.getuid?.() === 0) return; // root ignores permission bits
    const ro = join(home, "readonly");
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o500);
    const prev = process.env.BRAIN_HOME;
    process.env.BRAIN_HOME = join(ro, "brain");
    try {
      const r = await runDoctor({ env: OR_ENV, offline: true, repoRoot: null, gitVersion: gitOk });
      expect(byName(r.checks, "BRAIN_HOME").status).toBe("fail");
      expect(r.ok).toBe(false);
    } finally {
      process.env.BRAIN_HOME = prev;
      chmodSync(ro, 0o700);
    }
  });
});
