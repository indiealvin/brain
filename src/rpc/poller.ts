/**
 * Change detection for `repo.changed` (docs/mac-app/protocol.md §5;
 * design.md §5.3 item 4).
 *
 * Every check reads a durable fingerprint and compares it with the previous
 * check. A domain is listed when its component differs:
 *
 * | Domain          | Component |
 * |-----------------|-----------|
 * | `git`           | `main` and `agent/repo` heads (`git rev-parse`) |
 * | `index`         | `indexed_commit` and `PRAGMA data_version` of `index.sqlite` |
 * | `queue`         | `PRAGMA data_version` of `queue.sqlite` |
 * | `proposals`     | `PRAGMA data_version` of `proposals.sqlite` |
 * | `conversations` | the `*.jsonl` session files under `conversationsDir` and their sizes |
 *
 * (`knowledge`, on `knowledge.sqlite`, joins with CR-5.)
 *
 * Commit ids alone are not enough: an external mutation that ends in `NOOP`,
 * `REPLAN` or `FAILED` moves no head, and an external `brain index` adds
 * embeddings at an unchanged `indexed_commit`.
 *
 * - **Dedicated poll connections.** Each database gets one read-only
 *   connection that only this poller uses and that never writes.
 *   `data_version` changes whenever any *other* connection commits, in another
 *   process or in this one, so the server's own writes (which go through the
 *   coordinator's and the pipeline's connections) register too, with no manual
 *   dirty-marking.
 * - `data_version` is local to a connection: a component carries the
 *   connection's generation, so a value is only ever compared with one read on
 *   the same connection. A connection opened later (the file did not exist
 *   yet) or reopened (after a read error) counts as a change of its domain.
 * - A read that fails (a `SQLITE_BUSY`, a git error) leaves that component as
 *   it was, so the change is reported by a later check instead of being lost.
 * - The fingerprint is never persisted or sent; it only answers "did something
 *   change since my last check". The first check (`baseline`) reports nothing.
 * - `pendingProposals` is advisory: counted on the proposals poll connection,
 *   without the staleness refresh `listProposals()` runs under the worktree
 *   lock, so a check never waits behind an execute or integrate.
 * - The poller never takes a lock, and every read is synchronous and short,
 *   so a check never blocks on another process.
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_BRANCH, MAIN_BRANCH, type RepoPaths } from "../core/types";
import { runGit } from "../git/git";
import type { RepoChanged, RepoDomain } from "./dto";

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** The domains this server reports, in the order they are listed (protocol §5; `knowledge` joins with CR-5). */
export const REPO_DOMAINS: readonly RepoDomain[] = ["git", "index", "queue", "proposals", "conversations"];

/** A dedicated, read-only connection to one state database. Opened on first use; never writes. */
class PollConnection {
  private db: Database | null = null;
  /** Bumped on every (re)open: a `data_version` is comparable only within one generation. */
  private generation = 0;

  constructor(readonly file: string) {}

  /** `fn` on the open connection; null while the file does not exist or the read failed. */
  read<T>(fn: (db: Database, generation: number) => T): T | null {
    if (this.db === null) {
      if (!existsSync(this.file)) return null;
      try {
        this.db = new Database(this.file, { readonly: true });
        this.generation++;
      } catch {
        this.db = null;
        return null;
      }
    }
    try {
      return fn(this.db, this.generation);
    } catch (e) {
      // A busy database is read again next time on the same connection; anything else reopens it.
      if (!String((e as { code?: unknown })?.code ?? "").startsWith("SQLITE_BUSY")) this.close();
      return null;
    }
  }

  close(): void {
    const db = this.db;
    this.db = null;
    try {
      db?.close();
    } catch {}
  }
}

function dataVersion(db: Database): number {
  return (db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
}

type Fingerprint = Record<RepoDomain, string>;

/** One check's reading: a component per domain (null: unreadable this time), and the `RepoChanged` payload values. */
interface Reading {
  components: Partial<Record<RepoDomain, string | null>>;
  heads: { mainHead: string; agentHead: string } | null;
  indexedCommit: string | null | undefined;
  pendingProposals: number | null;
}

export class RepoChangePoller {
  private readonly paths: RepoPaths;
  private readonly index: PollConnection;
  private readonly queue: PollConnection;
  private readonly proposals: PollConnection;
  private last: Partial<Fingerprint> = {};
  private mainHead = "";
  private agentHead = "";
  private indexedCommit: string | null = null;
  private pendingProposals = 0;
  private hasBaseline = false;
  private closed = false;

  constructor(paths: RepoPaths) {
    this.paths = paths;
    this.index = new PollConnection(paths.indexDb);
    this.queue = new PollConnection(paths.queueDb);
    this.proposals = new PollConnection(paths.proposalsDb);
  }

  /** Take the baseline: open the poll connections and read every component, reporting nothing. */
  baseline(): void {
    this.check();
  }

  /** Compare with the previous check: the domains that moved and the current values, or null when none moved. */
  poll(): RepoChanged | null {
    const domains = this.check();
    if (domains.length === 0) return null;
    return { domains, mainHead: this.mainHead, agentHead: this.agentHead, indexedCommit: this.indexedCommit, pendingProposals: this.pendingProposals };
  }

  /** Close the poll connections. Later checks report nothing. */
  close(): void {
    this.closed = true;
    this.index.close();
    this.queue.close();
    this.proposals.close();
  }

  private check(): RepoDomain[] {
    if (this.closed) return [];
    const r = this.read();
    if (r.heads !== null) ({ mainHead: this.mainHead, agentHead: this.agentHead } = r.heads);
    if (r.indexedCommit !== undefined) this.indexedCommit = r.indexedCommit;
    if (r.pendingProposals !== null) this.pendingProposals = r.pendingProposals;
    const moved: RepoDomain[] = [];
    for (const d of REPO_DOMAINS) {
      const now = r.components[d];
      if (now === null || now === undefined) continue; // unreadable: keep the previous component
      const before = this.last[d];
      this.last[d] = now;
      // A component first read after the baseline (a database that appeared) counts as a change.
      if (before === undefined ? this.hasBaseline : before !== now) moved.push(d);
    }
    this.hasBaseline = true;
    return moved;
  }

  private read(): Reading {
    const components: Reading["components"] = {};
    let heads: Reading["heads"] = null;
    // One git process for both heads; `^{commit}` makes each argument a revision, never a path.
    const g = runGit(this.paths.userWorktree, ["rev-parse", `${MAIN_BRANCH}^{commit}`, `${AGENT_BRANCH}^{commit}`]);
    if (g.code === 0) {
      const [main, agent] = g.stdout.trim().split("\n");
      if (main !== undefined && agent !== undefined && SHA_RE.test(main) && SHA_RE.test(agent)) {
        heads = { mainHead: main, agentHead: agent };
        components.git = `${main} ${agent}`;
      }
    }
    let indexedCommit: Reading["indexedCommit"] = undefined;
    components.index = this.index.read((db, gen) => {
      const row = db.query("SELECT indexed_commit FROM index_meta LIMIT 1").get() as { indexed_commit: string | null } | null;
      const dv = dataVersion(db);
      indexedCommit = row?.indexed_commit ?? null;
      return `${indexedCommit ?? "-"} ${gen}:${dv}`;
    });
    components.queue = this.queue.read((db, gen) => `${gen}:${dataVersion(db)}`);
    let pendingProposals: number | null = null;
    components.proposals = this.proposals.read((db, gen) => {
      const dv = dataVersion(db);
      pendingProposals = (db.query("SELECT COUNT(*) AS n FROM proposals WHERE status = 'PENDING'").get() as { n: number }).n;
      return `${gen}:${dv}`;
    });
    components.conversations = this.sessionFiles();
    return { components, heads, indexedCommit, pendingProposals };
  }

  /** `<name>:<size>` of every `*.jsonl` session file, sorted; "" when the directory does not exist yet. */
  private sessionFiles(): string | null {
    const dir = this.paths.conversationsDir;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "ENOENT" ? "" : null;
    }
    const parts: string[] = [];
    for (const name of names.sort()) {
      try {
        parts.push(`${name}:${statSync(join(dir, name)).size}`);
      } catch {
        // removed between readdir and stat: absent
      }
    }
    return parts.join("\n");
  }
}
