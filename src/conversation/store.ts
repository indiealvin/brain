/**
 * Conversation store (spec §4.5, §6, §27; design §5).
 *
 * Transcripts live in application state, never in the knowledge repo:
 * one append-only JSONL file per session under `paths.conversationsDir`,
 * `<sessionId>.jsonl`. Line 1 is a session header; every following line is
 * one turn. Turn ids are zero-padded sequence numbers so that
 * `conversation://<sessionId>/<turnId>` (the grounding URI, §27) is stable
 * and sorts in order.
 *
 * Turn ids are unique across processes (CR-9, docs/mac-app/design.md §5.4):
 * `appendTurn` allocates each id from the session file on every call, never
 * from a per-instance cache, and writers call it only while holding the
 * session's turn lock (`src/conversation/turnLock.ts`; `runTurn` does).
 */
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isUlid, ulid } from "../core/ids";
import type { ConversationTurn, TurnRole } from "../core/types";

export const TURN_ID_WIDTH = 6;

interface SessionHeader {
  kind: "session";
  sessionId: string;
  createdAt: string;
}

interface TurnLine {
  kind: "turn";
  turnId: string;
  role: TurnRole;
  text: string;
  at: string;
}

/**
 * A turn as stored (CR-8): the core `ConversationTurn` plus `at`, the
 * ISO-8601 time `appendTurn` wrote to `TurnLine.at`, returned verbatim.
 */
export type StoredTurn = ConversationTurn & { at: string };

export interface SessionSummary {
  sessionId: string;
  createdAt: string;
  turns: number;
}

export interface ConversationStore {
  readonly dir: string;
  createSession(): string;
  /**
   * Append one turn. Its id is the number of turns in the session file plus
   * one, read from the file on every call. Callers hold the session's turn
   * lock (`withTurnLock`), so no other writer can append in between.
   */
  appendTurn(sessionId: string, role: TurnRole, text: string): ConversationTurn;
  getTurns(sessionId: string): ConversationTurn[];
  /** The same turns as `getTurns`, in session order, each with its stored timestamp. */
  getStoredTurns(sessionId: string): StoredTurn[];
  lastTurns(sessionId: string, n: number): ConversationTurn[];
  listSessions(): SessionSummary[];
  hasSession(sessionId: string): boolean;
}

export function turnUri(turn: Pick<ConversationTurn, "sessionId" | "turnId">): string {
  return `conversation://${turn.sessionId}/${turn.turnId}`;
}

export function formatTurnId(seq: number): string {
  return String(seq).padStart(TURN_ID_WIDTH, "0");
}

class JsonlConversationStore implements ConversationStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private file(sessionId: string): string {
    if (!isUlid(sessionId)) throw new Error(`invalid session id ${JSON.stringify(sessionId)}`);
    return join(this.dir, `${sessionId}.jsonl`);
  }

  private readLines(sessionId: string): { header: SessionHeader | null; turns: TurnLine[] } {
    const file = this.file(sessionId);
    if (!existsSync(file)) return { header: null, turns: [] };
    const raw = readFileSync(file, "utf8");
    let header: SessionHeader | null = null;
    const turns: TurnLine[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // a torn final line from a crash mid-append is ignored
      }
      const rec = obj as { kind?: string };
      if (rec.kind === "session") header = rec as SessionHeader;
      else if (rec.kind === "turn") turns.push(rec as TurnLine);
    }
    return { header, turns };
  }

  /** True when the file is non-empty and does not end in "\n" (a torn line from a crash mid-append). */
  private endsMidLine(file: string): boolean {
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      if (size === 0) return false;
      const buf = new Uint8Array(1);
      readSync(fd, buf, 0, 1, size - 1);
      return buf[0] !== 0x0a;
    } finally {
      closeSync(fd);
    }
  }

  hasSession(sessionId: string): boolean {
    return isUlid(sessionId) && existsSync(this.file(sessionId));
  }

  createSession(): string {
    const sessionId = ulid();
    const header: SessionHeader = { kind: "session", sessionId, createdAt: new Date().toISOString() };
    writeFileSync(this.file(sessionId), JSON.stringify(header) + "\n", { flag: "wx" });
    return sessionId;
  }

  appendTurn(sessionId: string, role: TurnRole, text: string): ConversationTurn {
    const file = this.file(sessionId);
    if (!existsSync(file)) throw new Error(`unknown session ${sessionId}`);
    // Always from the file (CR-9): another process, or another store instance, may have appended since this one last looked.
    const turnId = formatTurnId(this.readLines(sessionId).turns.length + 1);
    const line: TurnLine = { kind: "turn", turnId, role, text, at: new Date().toISOString() };
    // A torn trailing line (crash mid-append) is skipped by readLines; start on a fresh line so this record stays parseable.
    appendFileSync(file, (this.endsMidLine(file) ? "\n" : "") + JSON.stringify(line) + "\n");
    return { sessionId, turnId, role, text };
  }

  getTurns(sessionId: string): ConversationTurn[] {
    if (!isUlid(sessionId)) return [];
    return this.readLines(sessionId).turns.map((t) => ({ sessionId, turnId: t.turnId, role: t.role, text: t.text }));
  }

  getStoredTurns(sessionId: string): StoredTurn[] {
    if (!isUlid(sessionId)) return [];
    return this.readLines(sessionId).turns.map((t) => ({ sessionId, turnId: t.turnId, role: t.role, text: t.text, at: t.at }));
  }

  lastTurns(sessionId: string, n: number): ConversationTurn[] {
    if (n <= 0) return [];
    const all = this.getTurns(sessionId);
    return all.slice(Math.max(0, all.length - n));
  }

  listSessions(): SessionSummary[] {
    const out: SessionSummary[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const sessionId = name.slice(0, -".jsonl".length);
      if (!isUlid(sessionId)) continue;
      const { header, turns } = this.readLines(sessionId);
      out.push({ sessionId, createdAt: header?.createdAt ?? "", turns: turns.length });
    }
    return out.sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
  }
}

export function openConversationStore(dir: string): ConversationStore {
  return new JsonlConversationStore(dir);
}
