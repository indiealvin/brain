import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "changelog-section.sh");

function section(version: string, file = join(ROOT, "CHANGELOG.md")) {
  const r = Bun.spawnSync(["sh", SCRIPT, version, file], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() };
}

describe("CHANGELOG.md", () => {
  // The release workflow publishes this section as the release notes and
  // refuses to release without it, so a version bump fails here first.
  test("has a non-empty section for the package.json version", () => {
    const r = section(pkg.version);
    expect(r.code).toBe(0);
    expect(r.out.trim().length).toBeGreaterThan(0);
  });
});

describe("scripts/changelog-section.sh", () => {
  const file = join(mkdtempSync(join(tmpdir(), "changelog-")), "CHANGELOG.md");
  writeFileSync(
    file,
    [
      "# Changelog",
      "",
      "## Unreleased",
      "- next",
      "",
      "## v1.2.10 — 2026-01-02",
      "- ten",
      "",
      "## v1.2.1 — 2026-01-01",
      "",
      "### Fixed",
      "- one",
      "",
      "",
      "- also one",
      "",
      "## v1.2.0",
      "",
      "## v1.1.0",
      "- old",
      "",
    ].join("\n"),
  );

  test("prints the body up to the next heading, trimmed of blank edge lines", () => {
    expect(section("1.2.1", file)).toEqual({ code: 0, out: "### Fixed\n- one\n\n\n- also one\n" });
  });

  test("accepts a leading v and a heading without a date", () => {
    expect(section("v1.1.0", file)).toEqual({ code: 0, out: "- old\n" });
  });

  test("matches the whole version, not a prefix", () => {
    expect(section("1.2.10", file)).toEqual({ code: 0, out: "- ten\n" });
    expect(section("1.2", file).code).toBe(1);
  });

  test("fails for a missing or empty section", () => {
    expect(section("9.9.9", file).code).toBe(1);
    expect(section("1.2.0", file).code).toBe(1);
  });
});
