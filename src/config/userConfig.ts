/**
 * User-level configuration: `$BRAIN_HOME/config.toml` (never inside a
 * knowledge repo). Written by `brain setup`, read once at CLI startup and
 * projected onto the process environment for variables that are not already
 * set — the environment always wins over the file.
 *
 *   [model]
 *   provider = "openrouter"        # anthropic | openrouter
 *   model = "anthropic/claude-sonnet-4.5"
 *   effort = "medium"              # optional
 *   [keys]
 *   openrouter = "sk-or-..."
 *   anthropic = "sk-ant-..."
 *   [embeddings]
 *   provider = "openrouter"        # hashing | openrouter
 *   model = "openai/text-embedding-3-small"
 *   dims = 1536
 *
 * The file is created with mode 0600 because it holds API keys. Keys are
 * never printed in full; use `maskKey` for any output.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBrainHome } from "../core/brainHome";
import { formatToml, parseToml, type TomlTable, type TomlValue } from "../core/toml";

export const USER_CONFIG_FILE = "config.toml";

export type ModelProviderName = "anthropic" | "openrouter";
export type EmbeddingsProviderName = "hashing" | "openrouter";

export interface UserConfig {
  model?: { provider?: ModelProviderName; model?: string; effort?: string };
  keys?: { openrouter?: string; anthropic?: string };
  embeddings?: { provider?: EmbeddingsProviderName; model?: string; dims?: number };
}

/** `$BRAIN_HOME/config.toml`. */
export function userConfigPath(): string {
  return join(resolveBrainHome(), USER_CONFIG_FILE);
}

function str(t: TomlTable | undefined, key: string): string | undefined {
  const v = t?.[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function int(t: TomlTable | undefined, key: string): number | undefined {
  const v = t?.[key];
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

function table(t: TomlTable, key: string): TomlTable | undefined {
  const v = t[key];
  return v !== undefined && typeof v === "object" && !Array.isArray(v) ? v : undefined;
}

function oneOf<T extends string>(v: string | undefined, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  const lower = v.toLowerCase();
  return allowed.includes(lower as T) ? (lower as T) : undefined;
}

/** Convert a parsed TOML table into a `UserConfig`, dropping unknown or ill-typed entries. */
export function userConfigFromToml(root: TomlTable, warn: (msg: string) => void = () => {}): UserConfig {
  const cfg: UserConfig = {};
  const model = table(root, "model");
  if (model) {
    const provider = str(model, "provider");
    const kind = oneOf(provider, ["anthropic", "openrouter"] as const);
    if (provider !== undefined && kind === undefined) warn(`config: ignoring model.provider ${JSON.stringify(provider)} (expected anthropic | openrouter)`);
    cfg.model = { provider: kind, model: str(model, "model"), effort: str(model, "effort") };
  }
  const keys = table(root, "keys");
  if (keys) cfg.keys = { openrouter: str(keys, "openrouter"), anthropic: str(keys, "anthropic") };
  const emb = table(root, "embeddings");
  if (emb) {
    const provider = str(emb, "provider");
    const kind = oneOf(provider, ["hashing", "openrouter"] as const);
    if (provider !== undefined && kind === undefined) warn(`config: ignoring embeddings.provider ${JSON.stringify(provider)} (expected hashing | openrouter)`);
    const dims = int(emb, "dims");
    if (emb["dims"] !== undefined && dims === undefined) warn(`config: ignoring embeddings.dims ${JSON.stringify(emb["dims"])} (expected a positive integer)`);
    cfg.embeddings = { provider: kind, model: str(emb, "model"), dims };
  }
  return prune(cfg);
}

/** Drop undefined leaves and empty sections so the shape is stable for comparison and formatting. */
function prune(cfg: UserConfig): UserConfig {
  const out: UserConfig = {};
  for (const section of ["model", "keys", "embeddings"] as const) {
    const sub = cfg[section] as Record<string, unknown> | undefined;
    if (!sub) continue;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(sub)) if (v !== undefined && v !== null && v !== "") clean[k] = v;
    if (Object.keys(clean).length > 0) (out as Record<string, unknown>)[section] = clean;
  }
  return out;
}

/**
 * Read `$BRAIN_HOME/config.toml`. Returns null when the file does not exist
 * or cannot be parsed (a warning is emitted; the CLI must keep working from
 * the environment alone).
 */
export function loadUserConfig(opts: { warn?: (msg: string) => void; path?: string } = {}): UserConfig | null {
  const warn = opts.warn ?? ((m) => console.error(m));
  const path = opts.path ?? userConfigPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    warn(`config: cannot read ${path}: ${(e as Error).message}`);
    return null;
  }
  try {
    return userConfigFromToml(parseToml(text), warn);
  } catch (e) {
    warn(`config: ignoring malformed ${path}: ${(e as Error).message}; run \`brain setup\` to rewrite it`);
    return null;
  }
}

/** Serialize (sections in a fixed order, undefined leaves omitted). */
export function formatUserConfig(cfg: UserConfig): string {
  const clean = prune(cfg);
  const root: TomlTable = {};
  for (const section of ["model", "keys", "embeddings"] as const) {
    const sub = clean[section];
    if (sub) root[section] = { ...(sub as Record<string, TomlValue>) };
  }
  const header = "# brain user configuration — written by `brain setup`; environment variables override these values.\n";
  return header + formatToml(root);
}

/** Write the config with mode 0600 (directory created with `mkdir -p`). */
export function saveUserConfig(cfg: UserConfig, opts: { path?: string } = {}): string {
  const path = opts.path ?? userConfigPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, formatUserConfig(cfg), { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600); // `mode` only applies on create; fix an existing file too
  return path;
}

function setIfUnset(env: NodeJS.ProcessEnv, name: string, value: string | number | undefined): void {
  if (value === undefined) return;
  const cur = env[name];
  if (cur !== undefined && cur.trim() !== "") return;
  env[name] = String(value);
}

/**
 * Project the file onto the environment for variables that are unset or
 * blank. Returns the env for chaining. Safe to call with `null`.
 */
export function applyUserConfigToEnv(cfg: UserConfig | null, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!cfg) return env;
  setIfUnset(env, "BRAIN_MODEL_PROVIDER", cfg.model?.provider);
  setIfUnset(env, "BRAIN_MODEL", cfg.model?.model);
  setIfUnset(env, "BRAIN_EFFORT", cfg.model?.effort);
  setIfUnset(env, "OPENROUTER_API_KEY", cfg.keys?.openrouter);
  setIfUnset(env, "ANTHROPIC_API_KEY", cfg.keys?.anthropic);
  setIfUnset(env, "BRAIN_EMBEDDINGS", cfg.embeddings?.provider);
  setIfUnset(env, "BRAIN_EMBEDDING_MODEL", cfg.embeddings?.model);
  setIfUnset(env, "BRAIN_EMBEDDING_DIMS", cfg.embeddings?.dims);
  return env;
}

/**
 * `sk-or-v1-abcdef…wxyz` → `sk-or-…wxyz`. Keeps a recognisable vendor prefix
 * (`sk-or-`, `sk-ant-`) and the last four characters; never enough to
 * reconstruct a short key.
 */
export function maskKey(key: string | undefined): string {
  if (key === undefined || key === "") return "(none)";
  const m = key.match(/^[A-Za-z0-9]+-[A-Za-z0-9]+-/);
  const prefix = m ? m[0] : key.slice(0, Math.min(3, key.length));
  if (key.length < prefix.length + 8) return `${prefix}…`;
  return `${prefix}…${key.slice(-4)}`;
}
