/**
 * `runDoctor`'s live Anthropic check and CR-11 (docs/mac-app/design.md §10):
 * with `isolatedEnv` (the RPC server's `doctor.run`) credentials come from the
 * given env only; without it (the CLI) the SDK still fills what the env lacks
 * from `process.env`, as before. No network: global fetch is stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor, type DoctorCheck, type DoctorReport } from "../../src/config/doctor";
import { DEFAULT_MODEL } from "../../src/model/claude";

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "brain-doctor-creds-"));
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** Runs `fn` with `vars` set on process.env (`undefined` deletes), then restores every touched key. */
async function withProcessEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]] as const));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Every process.env key read while `fn` runs. */
async function processEnvReads(fn: () => Promise<void>): Promise<string[]> {
  const real = process.env;
  const reads: string[] = [];
  process.env = new Proxy(real, {
    get(target, key, receiver) {
      if (typeof key === "string") reads.push(key);
      return Reflect.get(target, key, receiver);
    },
  });
  try {
    await fn();
  } finally {
    process.env = real;
  }
  return reads;
}

/** The SDK always reads these two operator knobs; any other ANTHROPIC_* read is a credential lookup. */
const SDK_KNOBS = new Set(["ANTHROPIC_LOG", "ANTHROPIC_CUSTOM_HEADERS"]);
const credentialReads = (reads: string[]) => [...new Set(reads.filter((k) => k.startsWith("ANTHROPIC_") && !SDK_KNOBS.has(k)))];

/** Global fetch replaced by one that records requests and answers `models.retrieve`. */
function stubFetch(): { requests: { url: string; headers: Headers }[]; restore: () => void } {
  const original = globalThis.fetch;
  const requests: { url: string; headers: Headers }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: input instanceof Request ? input.url : String(input), headers: new Headers(init?.headers) });
    return Response.json({ type: "model", id: DEFAULT_MODEL, display_name: "Claude", created_at: "2026-01-01T00:00:00Z" });
  }) as unknown as typeof fetch;
  return { requests, restore: () => void (globalThis.fetch = original) };
}

const PROCESS_CREDENTIALS = {
  ANTHROPIC_API_KEY: "env-key",
  ANTHROPIC_AUTH_TOKEN: undefined,
  ANTHROPIC_BASE_URL: "http://env.invalid",
  ANTHROPIC_PROFILE: "env-profile",
  ANTHROPIC_CUSTOM_HEADERS: undefined,
};

const byName = (r: DoctorReport, name: string): DoctorCheck => r.checks.find((c) => c.name === name)!;

/** The live check alone: everything machine-specific is injected. */
async function doctorWith(env: NodeJS.ProcessEnv, isolatedEnv: boolean | undefined): Promise<{ report: DoctorReport; requests: { url: string; headers: Headers }[]; reads: string[] }> {
  let report!: DoctorReport;
  let requests: { url: string; headers: Headers }[] = [];
  let reads: string[] = [];
  await withProcessEnv({ ...PROCESS_CREDENTIALS, BRAIN_HOME: home }, async () => {
    const net = stubFetch();
    try {
      reads = await processEnvReads(async () => {
        report = await runDoctor({ env, isolatedEnv, repoRoot: null, gitVersion: () => "git version 2.43.0", brainOnPath: () => null, configPath: join(home, "none.toml") });
      });
      requests = net.requests;
    } finally {
      net.restore();
    }
  });
  return { report, requests, reads };
}

describe("doctor live Anthropic check, isolated env (RPC doctor.run)", () => {
  test("credentials come from env only: process.env's key, base URL and profile are never read or sent", async () => {
    const { report, requests, reads } = await doctorWith({ ANTHROPIC_AUTH_TOKEN: "private-token" }, true);
    expect(byName(report, "anthropic model")).toMatchObject({ status: "ok" });
    expect(credentialReads(reads)).toEqual([]);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url).toBe(`https://api.anthropic.com/v1/models/${DEFAULT_MODEL}`);
    expect(req.headers.get("authorization")).toBe("Bearer private-token");
    expect(req.headers.get("x-api-key")).toBeNull();
  });

  test("a key and base URL in env are used as given", async () => {
    const { requests } = await doctorWith({ ANTHROPIC_API_KEY: " private-key ", ANTHROPIC_BASE_URL: "http://private.invalid" }, true);
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0]!.url).origin).toBe("http://private.invalid");
    expect(requests[0]!.headers.get("x-api-key")).toBe("private-key");
    expect(requests[0]!.headers.get("authorization")).toBeNull();
  });
});

describe("doctor live Anthropic check, CLI default: unchanged", () => {
  test("what env lacks still comes from process.env (the SDK's own lookup)", async () => {
    for (const isolated of [undefined, false]) {
      const { report, requests, reads } = await doctorWith({ ANTHROPIC_AUTH_TOKEN: "private-token" }, isolated);
      expect(byName(report, "anthropic model").status).toBe("ok");
      expect(credentialReads(reads)).toEqual(expect.arrayContaining(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"]));
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0]!.url).origin).toBe("http://env.invalid");
      expect(requests[0]!.headers.get("x-api-key")).toBe("env-key");
    }
  });
});
