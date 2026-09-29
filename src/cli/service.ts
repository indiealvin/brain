/**
 * `brain watch --install | --uninstall | --status`: run the watch daemon as a
 * per-user service, one unit per knowledge repo (instance name = repo_id).
 *
 *   Linux  ~/.config/systemd/user/brain-watch@<repoId>.service  (systemd --user)
 *   macOS  ~/Library/LaunchAgents/io.brain.watch.<repoId>.plist  (launchd, gui/$UID)
 *
 * The service runs the *current* executable: the compiled binary when
 * running from `bun build --compile`, otherwise `<bun> <abs src/cli.ts>`.
 * `BRAIN_HOME` is baked into the unit so the daemon shares the installer's
 * state directory; API keys are not (the daemon reads $BRAIN_HOME/config.toml).
 *
 * Everything that touches the system is behind `ServiceEnv` (platform, home,
 * uid, and an `exec` shell-out) so tests can render units and check the
 * command sequence on both platforms without running systemctl/launchctl.
 */
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { resolveBrainHome } from "../core/brainHome";
import { CliError } from "./errors";

export type ServiceKind = "systemd" | "launchd";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (cmd: string, args: string[]) => ExecResult;

export interface ServiceEnv {
  /** `process.platform` (`linux` → systemd, `darwin` → launchd, anything else unsupported). */
  platform: string;
  exec: Exec;
  /** User home (unit / plist location). */
  home: string;
  /** `launchctl gui/<uid>` domain. */
  uid: number;
  /** Baked into the unit as `BRAIN_HOME`; also the launchd log location. */
  brainHome: string;
  /** argv prefix that runs this CLI (see `watchCommand`). */
  command: string[];
}

export const SYSTEMD_UNIT_PREFIX = "brain-watch@";
export const LAUNCHD_LABEL_PREFIX = "io.brain.watch.";

function defaultExec(cmd: string, args: string[]): ExecResult {
  try {
    const r = Bun.spawnSync([cmd, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * True when running from a `bun build --compile` binary. Verified against
 * Bun 1.4: inside a compiled binary `Bun.main` (and `process.argv[1]`) is a
 * path in the embedded virtual filesystem (`/$bunfs/root/<name>` on POSIX,
 * `B:\~BUN\root\<name>` on Windows) while `process.execPath` is the binary
 * itself; from source `Bun.main` is the real `.ts` path.
 */
export function isCompiledBinary(main: string = Bun.main): boolean {
  return main.startsWith("/$bunfs/") || main.includes("~BUN");
}

/** argv prefix for the service: the compiled binary, or `<bun> <abs cli.ts>` from source. Absolute paths only (services have no user PATH). */
export function watchCommand(): string[] {
  if (isCompiledBinary()) return [process.execPath];
  return [process.execPath, resolve(import.meta.dir, "..", "cli.ts")];
}

export function defaultServiceEnv(over: Partial<ServiceEnv> = {}): ServiceEnv {
  return {
    platform: over.platform ?? process.platform,
    exec: over.exec ?? defaultExec,
    home: over.home ?? homedir(),
    uid: over.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    brainHome: over.brainHome ?? resolveBrainHome(),
    command: over.command ?? watchCommand(),
  };
}

export interface ServiceSpec {
  kind: ServiceKind;
  /** Unit file / plist path. */
  path: string;
  /** systemd unit name (`brain-watch@<id>.service`) or launchd label (`io.brain.watch.<id>`). */
  name: string;
}

/** Where the service for `repoId` lives on this platform; null when unsupported. */
export function serviceSpec(repoId: string, env: ServiceEnv): ServiceSpec | null {
  if (env.platform === "linux") {
    const name = `${SYSTEMD_UNIT_PREFIX}${repoId}.service`;
    return { kind: "systemd", path: join(env.home, ".config", "systemd", "user", name), name };
  }
  if (env.platform === "darwin") {
    const name = `${LAUNCHD_LABEL_PREFIX}${repoId}`;
    return { kind: "launchd", path: join(env.home, "Library", "LaunchAgents", `${name}.plist`), name };
  }
  return null;
}

/** Offline detection (file existence only), shared with `brain doctor`. */
export function installedService(repoId: string, env: ServiceEnv = defaultServiceEnv()): ServiceSpec | null {
  const spec = serviceSpec(repoId, env);
  return spec !== null && existsSync(spec.path) ? spec : null;
}

/** One line for `brain doctor`: `installed (systemd unit …)` / `installed (launchd …)` / `not installed; …`. */
export function describeInstalledService(repoId: string, env: ServiceEnv = defaultServiceEnv()): string {
  const spec = serviceSpec(repoId, env);
  if (spec === null) return `not installed (no service manager support on ${env.platform})`;
  if (!existsSync(spec.path)) return "not installed; run brain watch --install";
  return spec.kind === "systemd" ? `installed (systemd unit ${spec.path})` : `installed (launchd ${spec.path})`;
}

export interface WatchServiceArgs {
  /** Absolute path of the knowledge repo (the directory holding brain.toml). */
  repoDir: string;
  repoId: string;
  intervalMs: number;
}

function watchArgv(args: WatchServiceArgs, env: ServiceEnv): string[] {
  return [...env.command, "watch", "--repo", args.repoDir, "--interval", String(args.intervalMs)];
}

/** systemd quoting: `%` is a specifier, double quotes wrap args with whitespace or quotes. */
function systemdArg(a: string): string {
  const s = a.replace(/%/g, "%%");
  return /[\s"'\\]/.test(s) ? `"${s.replace(/(["\\])/g, "\\$1")}"` : s;
}

/** `Environment=` values are unquoted at parse time; quote when needed. */
function systemdEnvValue(name: string, value: string): string {
  const s = value.replace(/%/g, "%%");
  return /[\s"'\\]/.test(s) ? `"${name}=${s.replace(/(["\\])/g, "\\$1")}"` : `${name}=${s}`;
}

export function renderSystemdUnit(args: WatchServiceArgs, env: ServiceEnv): string {
  return [
    "[Unit]",
    `Description=brain watch (${args.repoDir})`,
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${watchArgv(args, env).map(systemdArg).join(" ")}`,
    `Environment=${systemdEnvValue("BRAIN_HOME", env.brainHome)}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** `$BRAIN_HOME/repos/<repoId>/runtime/watch.log` (launchd stdout + stderr). */
export function launchdLogPath(repoId: string, env: ServiceEnv): string {
  return join(env.brainHome, "repos", repoId, "runtime", "watch.log");
}

export function renderLaunchdPlist(args: WatchServiceArgs, env: ServiceEnv): string {
  const label = `${LAUNCHD_LABEL_PREFIX}${args.repoId}`;
  const log = launchdLogPath(args.repoId, env);
  const argv = watchArgv(args, env)
    .map((a) => `    <string>${xml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argv}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BRAIN_HOME</key>
    <string>${xml(env.brainHome)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function unsupported(env: ServiceEnv): CliError {
  return new CliError(`watch --install is supported on Linux (systemd --user) and macOS (launchd) only; this is ${env.platform}. Run \`brain watch\` under your own supervisor instead.`);
}

function failed(what: string, r: ExecResult): CliError {
  const detail = `${r.stderr}${r.stdout}`.trim();
  return new CliError(`${what} failed (exit ${r.code})${detail ? `: ${detail}` : ""}`);
}

export interface ServiceOutcome {
  spec: ServiceSpec;
  /** Human-readable lines for the CLI to print. */
  lines: string[];
}

/** Write the unit/plist, register it and start it. Re-running rewrites the file and restarts the daemon. */
export function installWatchService(args: WatchServiceArgs, env: ServiceEnv = defaultServiceEnv()): ServiceOutcome {
  const spec = serviceSpec(args.repoId, env);
  if (spec === null) throw unsupported(env);
  const existed = existsSync(spec.path);
  mkdirSync(join(spec.path, ".."), { recursive: true });
  if (spec.kind === "systemd") {
    writeFileSync(spec.path, renderSystemdUnit(args, env));
    const reload = env.exec("systemctl", ["--user", "daemon-reload"]);
    if (reload.code !== 0) throw failed("systemctl --user daemon-reload", reload);
    const enable = env.exec("systemctl", ["--user", "enable", "--now", spec.name]);
    if (enable.code !== 0) throw failed(`systemctl --user enable --now ${spec.name}`, enable);
    if (existed) {
      // `enable --now` leaves an already-running instance on the old ExecStart; pick up the rewritten unit.
      const restart = env.exec("systemctl", ["--user", "restart", spec.name]);
      if (restart.code !== 0) throw failed(`systemctl --user restart ${spec.name}`, restart);
    }
    return {
      spec,
      lines: [
        `installed systemd user unit ${spec.path}`,
        `started ${spec.name} (logs: journalctl --user -u ${spec.name} -f)`,
        "hint: on a headless machine run `loginctl enable-linger $USER` so the unit runs without a login session",
      ],
    };
  }
  mkdirSync(join(launchdLogPath(args.repoId, env), ".."), { recursive: true });
  writeFileSync(spec.path, renderLaunchdPlist(args, env));
  const domain = `gui/${env.uid}`;
  const target = `${domain}/${spec.name}`;
  // launchd keeps the plist it loaded; unload a previous copy so the rewritten one is read.
  if (existed) env.exec("launchctl", ["bootout", target]);
  const bootstrap = env.exec("launchctl", ["bootstrap", domain, spec.path]);
  let how = `launchctl bootstrap ${domain}`;
  if (bootstrap.code !== 0) {
    const load = env.exec("launchctl", ["load", "-w", spec.path]);
    if (load.code !== 0) throw failed(`launchctl bootstrap ${domain} ${spec.path} (and the launchctl load -w fallback)`, load);
    how = "launchctl load -w";
  }
  const kick = env.exec("launchctl", ["kickstart", "-k", target]);
  if (kick.code !== 0) throw failed(`launchctl kickstart -k ${target}`, kick);
  return {
    spec,
    lines: [`installed launchd agent ${spec.path}`, `started ${spec.name} via ${how} (logs: ${launchdLogPath(args.repoId, env)})`],
  };
}

/** Stop, unregister and remove the unit/plist. A missing unit is not an error. */
export function uninstallWatchService(repoId: string, env: ServiceEnv = defaultServiceEnv()): ServiceOutcome {
  const spec = serviceSpec(repoId, env);
  if (spec === null) throw unsupported(env);
  if (!existsSync(spec.path)) return { spec, lines: [`not installed (no ${spec.path})`] };
  if (spec.kind === "systemd") {
    const disable = env.exec("systemctl", ["--user", "disable", "--now", spec.name]);
    if (disable.code !== 0) throw failed(`systemctl --user disable --now ${spec.name}`, disable);
    unlinkSync(spec.path);
    const reload = env.exec("systemctl", ["--user", "daemon-reload"]);
    if (reload.code !== 0) throw failed("systemctl --user daemon-reload", reload);
    return { spec, lines: [`stopped ${spec.name}`, `removed ${spec.path}`] };
  }
  const target = `gui/${env.uid}/${spec.name}`;
  // bootout fails when the agent is not loaded (e.g. after a reboot without RunAtLoad); the plist is removed either way.
  const out = env.exec("launchctl", ["bootout", target]);
  unlinkSync(spec.path);
  return { spec, lines: [out.code === 0 ? `stopped ${spec.name}` : `${spec.name} was not loaded`, `removed ${spec.path}`] };
}

export interface ServiceStatus {
  spec: ServiceSpec;
  installed: boolean;
  running: boolean;
  lines: string[];
}

export function watchServiceStatus(repoId: string, env: ServiceEnv = defaultServiceEnv()): ServiceStatus {
  const spec = serviceSpec(repoId, env);
  if (spec === null) throw unsupported(env);
  if (!existsSync(spec.path)) return { spec, installed: false, running: false, lines: [`not installed (no ${spec.path}); run brain watch --install`] };
  let running: boolean;
  if (spec.kind === "systemd") running = env.exec("systemctl", ["--user", "is-active", spec.name]).code === 0;
  else running = env.exec("launchctl", ["print", `gui/${env.uid}/${spec.name}`]).code === 0;
  return { spec, installed: true, running, lines: [`${running ? "running" : "stopped"} (${spec.kind === "systemd" ? "systemd unit" : "launchd agent"} ${spec.path})`] };
}
