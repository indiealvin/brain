import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../../src/cli/errors";
import {
  defaultServiceEnv,
  describeInstalledService,
  installedService,
  installWatchService,
  isCompiledBinary,
  launchdLogPath,
  renderLaunchdPlist,
  renderSystemdUnit,
  serviceSpec,
  uninstallWatchService,
  watchCommand,
  watchServiceStatus,
  type Exec,
  type ExecResult,
  type ServiceEnv,
} from "../../src/cli/service";
import { runDoctor } from "../../src/config/doctor";
import { makeTempKnowledgeRepo, withBrainHome } from "../harness";

const REPO_ID = "01SERVICE0000000000000TEST";
const ARGS = { repoDir: "/home/u/notes", repoId: REPO_ID, intervalMs: 2500 };

/** Records every shell-out; `responses` maps "cmd args…" prefixes to results (default success). */
function fakeExec(responses: Record<string, ExecResult> = {}): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  const exec: Exec = (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    for (const [prefix, r] of Object.entries(responses)) if (line.startsWith(prefix)) return r;
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "brain-service-home-"));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function env(over: Partial<ServiceEnv>): ServiceEnv {
  return defaultServiceEnv({ home, uid: 501, brainHome: "/home/u/.brain", command: ["/opt/brain/bin/brain"], exec: fakeExec().exec, ...over });
}

describe("watch service: command detection", () => {
  test("compiled binaries are recognised by the embedded-filesystem main path; from source the command is <bun> <abs cli.ts>", () => {
    expect(isCompiledBinary("/$bunfs/root/brain")).toBe(true);
    expect(isCompiledBinary("B:\\~BUN\\root\\brain.exe")).toBe(true);
    expect(isCompiledBinary("/home/u/brain/src/cli.ts")).toBe(false);
    // this test runs from source
    expect(isCompiledBinary()).toBe(false);
    const cmd = watchCommand();
    expect(cmd).toHaveLength(2);
    expect(cmd[0]).toBe(process.execPath); // absolute bun, never a bare `bun` (services have no user PATH)
    expect(cmd[1]).toMatch(/\/src\/cli\.ts$/);
    expect(existsSync(cmd[1]!)).toBe(true);
  });
});

describe("watch service on Linux (systemd --user)", () => {
  test("renders one unit per repo with an absolute ExecStart, restart policy and BRAIN_HOME", () => {
    const e = env({ platform: "linux" });
    const spec = serviceSpec(REPO_ID, e)!;
    expect(spec.kind).toBe("systemd");
    expect(spec.name).toBe(`brain-watch@${REPO_ID}.service`);
    expect(spec.path).toBe(join(home, ".config", "systemd", "user", `brain-watch@${REPO_ID}.service`));
    const unit = renderSystemdUnit(ARGS, e);
    expect(unit).toContain("[Unit]\n");
    expect(unit).toContain("[Service]\nType=simple\nExecStart=/opt/brain/bin/brain watch --repo /home/u/notes --interval 2500\nEnvironment=BRAIN_HOME=/home/u/.brain\nRestart=on-failure\nRestartSec=5\n");
    expect(unit).toContain("[Install]\nWantedBy=default.target\n");

    // from source: bun + cli.ts; paths with spaces / percent signs are quoted and escaped for systemd
    const src = renderSystemdUnit({ ...ARGS, repoDir: "/home/u/my notes/100%" }, env({ platform: "linux", command: ["/home/u/.bun/bin/bun", "/home/u/src dir/cli.ts"], brainHome: "/home/u/brain home" }));
    expect(src).toContain('ExecStart=/home/u/.bun/bin/bun "/home/u/src dir/cli.ts" watch --repo "/home/u/my notes/100%%" --interval 2500\n');
    expect(src).toContain('Environment="BRAIN_HOME=/home/u/brain home"\n');
  });

  test("install writes the unit then daemon-reload + enable --now; status uses is-active; uninstall disables and removes", () => {
    const { exec, calls } = fakeExec();
    const e = env({ platform: "linux", exec });
    const spec = serviceSpec(REPO_ID, e)!;
    expect(installedService(REPO_ID, e)).toBeNull();
    expect(describeInstalledService(REPO_ID, e)).toBe("not installed; run brain watch --install");

    const r = installWatchService(ARGS, e);
    expect(existsSync(spec.path)).toBe(true);
    expect(readFileSync(spec.path, "utf8")).toBe(renderSystemdUnit(ARGS, e));
    expect(calls).toEqual(["systemctl --user daemon-reload", `systemctl --user enable --now ${spec.name}`]);
    expect(r.lines[0]).toBe(`installed systemd user unit ${spec.path}`);
    expect(r.lines.join("\n")).toContain("loginctl enable-linger $USER");
    expect(installedService(REPO_ID, e)?.path).toBe(spec.path);
    expect(describeInstalledService(REPO_ID, e)).toBe(`installed (systemd unit ${spec.path})`);

    // re-install (e.g. a new interval) rewrites the unit and restarts the running instance
    calls.length = 0;
    installWatchService({ ...ARGS, intervalMs: 500 }, e);
    expect(readFileSync(spec.path, "utf8")).toContain("--interval 500");
    expect(calls).toEqual(["systemctl --user daemon-reload", `systemctl --user enable --now ${spec.name}`, `systemctl --user restart ${spec.name}`]);

    calls.length = 0;
    const running = watchServiceStatus(REPO_ID, e);
    expect(calls).toEqual([`systemctl --user is-active ${spec.name}`]);
    expect(running).toMatchObject({ installed: true, running: true });
    expect(running.lines).toEqual([`running (systemd unit ${spec.path})`]);
    const stoppedEnv = env({ platform: "linux", exec: fakeExec({ "systemctl --user is-active": { code: 3, stdout: "inactive\n", stderr: "" } }).exec });
    expect(watchServiceStatus(REPO_ID, stoppedEnv)).toMatchObject({ installed: true, running: false });
    expect(watchServiceStatus(REPO_ID, stoppedEnv).lines[0]).toStartWith("stopped (");

    calls.length = 0;
    const u = uninstallWatchService(REPO_ID, e);
    expect(calls).toEqual([`systemctl --user disable --now ${spec.name}`, "systemctl --user daemon-reload"]);
    expect(existsSync(spec.path)).toBe(false);
    expect(u.lines).toEqual([`stopped ${spec.name}`, `removed ${spec.path}`]);
    expect(watchServiceStatus(REPO_ID, e)).toMatchObject({ installed: false, running: false });
    expect(watchServiceStatus(REPO_ID, e).lines[0]).toContain("not installed");
    // uninstalling twice is not an error
    expect(uninstallWatchService(REPO_ID, e).lines[0]).toStartWith("not installed");
  });

  test("a failing systemctl surfaces as a CliError and leaves nothing half-done to guess about", () => {
    const e = env({ platform: "linux", exec: fakeExec({ "systemctl --user enable": { code: 1, stdout: "", stderr: "Failed to connect to bus" } }).exec });
    expect(() => installWatchService(ARGS, e)).toThrow(/enable --now .* failed \(exit 1\): Failed to connect to bus/);
    rmSync(serviceSpec(REPO_ID, e)!.path, { force: true });
  });
});

describe("watch service on macOS (launchd)", () => {
  test("renders a LaunchAgent plist with label, arguments, RunAtLoad, KeepAlive and log paths under BRAIN_HOME", () => {
    const e = env({ platform: "darwin", brainHome: "/Users/u/.brain" });
    const spec = serviceSpec(REPO_ID, e)!;
    expect(spec.kind).toBe("launchd");
    expect(spec.name).toBe(`io.brain.watch.${REPO_ID}`);
    expect(spec.path).toBe(join(home, "Library", "LaunchAgents", `io.brain.watch.${REPO_ID}.plist`));
    expect(launchdLogPath(REPO_ID, e)).toBe(`/Users/u/.brain/repos/${REPO_ID}/runtime/watch.log`);
    const plist = renderLaunchdPlist({ ...ARGS, repoDir: "/Users/u/notes & <ideas>" }, e);
    expect(plist).toContain(`<key>Label</key>\n  <string>io.brain.watch.${REPO_ID}</string>`);
    expect(plist).toContain("<key>ProgramArguments</key>\n  <array>\n    <string>/opt/brain/bin/brain</string>\n    <string>watch</string>\n    <string>--repo</string>\n    <string>/Users/u/notes &amp; &lt;ideas&gt;</string>\n    <string>--interval</string>\n    <string>2500</string>\n  </array>");
    expect(plist).toContain("<key>EnvironmentVariables</key>\n  <dict>\n    <key>BRAIN_HOME</key>\n    <string>/Users/u/.brain</string>\n  </dict>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>");
    expect(plist).toContain(`<key>StandardOutPath</key>\n  <string>/Users/u/.brain/repos/${REPO_ID}/runtime/watch.log</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key>\n  <string>/Users/u/.brain/repos/${REPO_ID}/runtime/watch.log</string>`);
  });

  test("install = bootstrap gui/$UID + kickstart -k (load -w when bootstrap fails); status = launchctl print; uninstall = bootout + rm", () => {
    const brainHome = mkdtempSync(join(tmpdir(), "brain-service-bh-"));
    try {
      const { exec, calls } = fakeExec();
      const e = env({ platform: "darwin", exec, brainHome });
      const spec = serviceSpec(REPO_ID, e)!;
      const r = installWatchService(ARGS, e);
      expect(readFileSync(spec.path, "utf8")).toBe(renderLaunchdPlist(ARGS, e));
      expect(existsSync(join(brainHome, "repos", REPO_ID, "runtime"))).toBe(true); // log directory exists before launchd opens the log
      expect(calls).toEqual([`launchctl bootstrap gui/501 ${spec.path}`, `launchctl kickstart -k gui/501/${spec.name}`]);
      expect(r.lines[0]).toBe(`installed launchd agent ${spec.path}`);
      expect(r.lines[1]).toContain("launchctl bootstrap gui/501");
      expect(describeInstalledService(REPO_ID, e)).toBe(`installed (launchd ${spec.path})`);

      // re-install: the old copy is booted out first; a failing bootstrap falls back to load -w
      const fb = fakeExec({ "launchctl bootstrap": { code: 5, stdout: "", stderr: "Input/output error" } });
      const e2 = env({ platform: "darwin", exec: fb.exec, brainHome });
      const r2 = installWatchService(ARGS, e2);
      expect(fb.calls).toEqual([
        `launchctl bootout gui/501/${spec.name}`,
        `launchctl bootstrap gui/501 ${spec.path}`,
        `launchctl load -w ${spec.path}`,
        `launchctl kickstart -k gui/501/${spec.name}`,
      ]);
      expect(r2.lines[1]).toContain("via launchctl load -w");

      calls.length = 0;
      expect(watchServiceStatus(REPO_ID, e)).toMatchObject({ installed: true, running: true });
      expect(calls).toEqual([`launchctl print gui/501/${spec.name}`]);
      const down = env({ platform: "darwin", exec: fakeExec({ "launchctl print": { code: 113, stdout: "", stderr: "Could not find service" } }).exec, brainHome });
      expect(watchServiceStatus(REPO_ID, down)).toMatchObject({ installed: true, running: false });

      calls.length = 0;
      const u = uninstallWatchService(REPO_ID, e);
      expect(calls).toEqual([`launchctl bootout gui/501/${spec.name}`]);
      expect(existsSync(spec.path)).toBe(false);
      expect(u.lines).toEqual([`stopped ${spec.name}`, `removed ${spec.path}`]);
    } finally {
      rmSync(brainHome, { recursive: true, force: true });
    }
  });
});

describe("watch service elsewhere", () => {
  test("unsupported platforms fail with exit 1 and a clear message; doctor reports not installed", () => {
    const e = env({ platform: "win32" });
    expect(serviceSpec(REPO_ID, e)).toBeNull();
    for (const f of [() => installWatchService(ARGS, e), () => uninstallWatchService(REPO_ID, e), () => watchServiceStatus(REPO_ID, e)]) {
      let err: unknown;
      try {
        f();
      } catch (x) {
        err = x;
      }
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(1);
      expect((err as CliError).message).toContain("win32");
      expect((err as CliError).message).toContain("Linux (systemd --user) and macOS (launchd) only");
    }
    expect(describeInstalledService(REPO_ID, e)).toBe("not installed (no service manager support on win32)");
  });
});

describe("brain doctor: watch service detection (offline, file existence only)", () => {
  test("reports installed (systemd unit …) / installed (launchd …) / not installed next to the pid-file state", async () => {
    const bh = withBrainHome();
    const repo = makeTempKnowledgeRepo();
    try {
      const base = { offline: true, repoRoot: repo.path, gitVersion: () => "git version 2.45.0", env: { OPENROUTER_API_KEY: "sk-or-v1-doctor000000000abcd" } };
      const watchLine = async (service: Partial<ServiceEnv>) => (await runDoctor({ ...base, service })).checks.find((c) => c.name === "watch")!;

      const none = await watchLine({ platform: "linux", home });
      expect(none.status).toBe("info");
      expect(none.detail).toMatch(/^unknown \(no .*watch\.pid\); not installed; run brain watch --install$/);

      const { exec } = fakeExec();
      const linux = env({ platform: "linux", exec });
      installWatchService({ repoDir: repo.path, repoId: repo.repoId, intervalMs: 1000 }, linux);
      const unit = serviceSpec(repo.repoId, linux)!.path;
      expect((await watchLine({ platform: "linux", home })).detail).toContain(`installed (systemd unit ${unit})`);
      expect((await watchLine({ platform: "linux", home })).detail).toStartWith("unknown (no ");
      uninstallWatchService(repo.repoId, linux);
      expect((await watchLine({ platform: "linux", home })).detail).toContain("not installed; run brain watch --install");

      const mac = env({ platform: "darwin", exec, brainHome: bh.home });
      installWatchService({ repoDir: repo.path, repoId: repo.repoId, intervalMs: 1000 }, mac);
      expect((await watchLine({ platform: "darwin", home })).detail).toContain(`installed (launchd ${serviceSpec(repo.repoId, mac)!.path})`);
      uninstallWatchService(repo.repoId, mac);

      expect((await watchLine({ platform: "freebsd", home })).detail).toContain("not installed (no service manager support on freebsd)");
    } finally {
      repo.cleanup();
      bh.cleanup();
    }
  });
});
