/**
 * Conformance transcripts (docs/mac-app/protocol.md §9): every
 * test/rpc/transcripts/*.jsonl is replayed against a fresh
 * `brain rpc --stdio` in a temp BRAIN_HOME. Harness rules: harness/replay.ts.
 */
import { afterEach, describe, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { killAllServers, replayTranscript } from "./harness";

const DIR = join(import.meta.dir, "transcripts");
const TIMEOUT_MS = 60_000;

afterEach(killAllServers);

describe("rpc transcripts", () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).sort()) {
    test(file, () => replayTranscript(join(DIR, file)), TIMEOUT_MS);
  }
});
