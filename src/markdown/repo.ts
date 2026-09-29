/**
 * Knowledge repository configuration and initialization (spec §4–5, §16).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { BrainConfig } from "../core/types";
import { ulid } from "../core/ids";
import { formatToml, parseToml, TomlError, type TomlTable, type TomlValue } from "../core/toml";
import { gitWith, identityEnv, isRepoRoot, refExists, runGit } from "../git/git";

export const CONFIG_FILE = "brain.toml";
export const CONFIG_VERSION = 1;

export const DEFAULT_RELATIONSHIPS = ["related", "supports", "contradicts", "extends", "example-of"];
export const DEFAULT_QUIESCENCE_MS = 1500;
export const DEFAULT_LOW_CONTENT_MAX_TOKENS = 4;
export const DEFAULT_CONFIRMATION_LEXICON = [
  "yes",
  "yeah",
  "yep",
  "exactly",
  "right",
  "correct",
  "agreed",
  "i agree",
  "that's it",
  "that's what i mean",
];

export const DEFAULT_GITIGNORE_LINES = [".obsidian/workspace*", ".brain/"];

export const DEFAULT_AGENTS_MD = `# Agents

This is a Brain knowledge repository. Humans edit \`knowledge/*.md\` on \`main\`;
the agent commits to \`agent/repo\` in its own worktree and integrates with
\`git merge --ff-only\`.

Conventions:

- Every note has YAML frontmatter with \`id\`, \`created\`, \`type\`, \`status\`
  and optional \`aliases\`. The \`# Title\` heading is the title.
- Slugs (file basenames) and aliases share one case-insensitive namespace.
  Never rename a file without adding the old slug as an alias.
- Links are \`[[slug]]\` or \`[[slug|Display]]\`. Typed links live under
  \`## Connections\` as \`- <relationship> [[slug]]\`.
- Grounded content sits under \`## Claim\`, \`## Evidence\`, \`## Evolution\`;
  agent inferences under \`## Agent inference\`.
- Do not edit \`brain.toml\` \`repo_id\`.
`;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function asTable(v: TomlValue | undefined, name: string): TomlTable {
  if (v === undefined) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`[${name}] must be a table`);
  return v;
}

function asNumber(v: TomlValue | undefined, name: string, dflt: number): number {
  if (v === undefined) return dflt;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ConfigError(`${name} must be a number`);
  return v;
}

function asStringArray(v: TomlValue | undefined, name: string, dflt: string[]): string[] {
  if (v === undefined) return dflt.slice();
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ConfigError(`${name} must be an array of strings`);
  return v.slice() as string[];
}

/** Map parsed TOML (snake_case, spec §5) onto BrainConfig (camelCase). */
export function configFromToml(table: TomlTable): BrainConfig {
  const version = table["version"];
  if (typeof version !== "number") throw new ConfigError("version is required and must be a number");
  if (version !== CONFIG_VERSION) throw new ConfigError(`unsupported brain.toml version ${version} (expected ${CONFIG_VERSION})`);
  const repoId = table["repo_id"];
  if (typeof repoId !== "string" || repoId.trim() === "") throw new ConfigError("repo_id is required and must be a non-empty string");
  const links = asTable(table["links"], "links");
  const sync = asTable(table["sync"], "sync");
  const grounding = asTable(table["grounding"], "grounding");
  return {
    version,
    repoId,
    links: { relationships: asStringArray(links["relationships"], "links.relationships", DEFAULT_RELATIONSHIPS) },
    sync: { quiescenceMs: asNumber(sync["quiescence_ms"], "sync.quiescence_ms", DEFAULT_QUIESCENCE_MS) },
    grounding: {
      lowContentMaxTokens: asNumber(grounding["low_content_max_tokens"], "grounding.low_content_max_tokens", DEFAULT_LOW_CONTENT_MAX_TOKENS),
      confirmationLexicon: asStringArray(grounding["confirmation_lexicon"], "grounding.confirmation_lexicon", DEFAULT_CONFIRMATION_LEXICON),
    },
  };
}

/** Inverse of configFromToml. */
export function configToToml(config: BrainConfig): string {
  return formatToml({
    version: config.version,
    repo_id: config.repoId,
    links: { relationships: config.links.relationships },
    sync: { quiescence_ms: config.sync.quiescenceMs },
    grounding: {
      low_content_max_tokens: config.grounding.lowContentMaxTokens,
      confirmation_lexicon: config.grounding.confirmationLexicon,
    },
  });
}

export function parseConfig(src: string): BrainConfig {
  let table: TomlTable;
  try {
    table = parseToml(src);
  } catch (e) {
    if (e instanceof TomlError) throw new ConfigError(`invalid brain.toml: ${e.message}`);
    throw e;
  }
  return configFromToml(table);
}

/** Read and validate `<userWorktree>/brain.toml`. */
export function loadConfig(userWorktree: string): BrainConfig {
  const file = join(userWorktree, CONFIG_FILE);
  if (!existsSync(file)) throw new ConfigError(`${file} not found; run \`brain init\``);
  return parseConfig(readFileSync(file, "utf8"));
}

export interface InitOptions {
  /** Only used when no brain.toml exists yet. */
  repoId?: string;
  quiescenceMs?: number;
  relationships?: string[];
  lowContentMaxTokens?: number;
  confirmationLexicon?: string[];
}

export interface InitResult {
  path: string;
  config: BrainConfig;
  /** brain.toml was written by this call. */
  createdConfig: boolean;
  /** `git init` was run by this call. */
  createdRepo: boolean;
  /** Commit created by this call, if any. */
  commitSha?: string;
  /** Files written by this call (repo-relative). */
  written: string[];
}

function ensureGitignore(dir: string): boolean {
  const file = join(dir, ".gitignore");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = DEFAULT_GITIGNORE_LINES.filter((l) => !have.has(l));
  if (missing.length === 0) return false;
  const prefix = existing === "" || existing.endsWith("\n") ? existing : existing + "\n";
  writeFileSync(file, prefix + missing.join("\n") + "\n");
  return true;
}

/**
 * `brain init` (spec §5, §16): idempotent. Writes brain.toml (fresh ULID
 * repo_id, never regenerated), .gitignore, AGENTS.md, knowledge/.keep, runs
 * `git init -b main` when `dir` is not already a repository root, and makes
 * an initial commit when the repository has no commits yet.
 */
export function initKnowledgeRepo(dir: string, opts: InitOptions = {}): InitResult {
  const path = resolve(dir);
  mkdirSync(path, { recursive: true });
  const written: string[] = [];

  const configFile = join(path, CONFIG_FILE);
  let config: BrainConfig;
  let createdConfig = false;
  if (existsSync(configFile)) {
    config = loadConfig(path);
  } else {
    config = {
      version: CONFIG_VERSION,
      repoId: opts.repoId ?? ulid(),
      links: { relationships: (opts.relationships ?? DEFAULT_RELATIONSHIPS).slice() },
      sync: { quiescenceMs: opts.quiescenceMs ?? DEFAULT_QUIESCENCE_MS },
      grounding: {
        lowContentMaxTokens: opts.lowContentMaxTokens ?? DEFAULT_LOW_CONTENT_MAX_TOKENS,
        confirmationLexicon: (opts.confirmationLexicon ?? DEFAULT_CONFIRMATION_LEXICON).slice(),
      },
    };
    writeFileSync(configFile, configToToml(config));
    createdConfig = true;
    written.push(CONFIG_FILE);
  }

  if (ensureGitignore(path)) written.push(".gitignore");

  const agentsFile = join(path, "AGENTS.md");
  if (!existsSync(agentsFile)) {
    writeFileSync(agentsFile, DEFAULT_AGENTS_MD);
    written.push("AGENTS.md");
  }

  mkdirSync(join(path, "knowledge"), { recursive: true });
  const keep = join(path, "knowledge", ".keep");
  if (!existsSync(keep)) {
    writeFileSync(keep, "");
    written.push("knowledge/.keep");
  }

  let createdRepo = false;
  if (!isRepoRoot(path)) {
    gitWith(path, ["init", "-q", "-b", "main"]);
    createdRepo = true;
  }

  const result: InitResult = { path, config, createdConfig, createdRepo, written };
  if (!refExists(path, "HEAD")) {
    gitWith(path, ["add", "-A"]);
    const staged = runGit(path, ["diff", "--cached", "--quiet"]);
    if (staged.code !== 0) {
      gitWith(path, ["commit", "-q", "-m", "brain: init\n\nActor: human\n"], { env: identityEnv(path) });
      result.commitSha = gitWith(path, ["rev-parse", "HEAD"]);
    }
  }
  return result;
}
