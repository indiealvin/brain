/**
 * History methods (docs/mac-app/protocol.md §4 History; CR-4):
 * `history.list` and `history.diff`. Thin adapters over the service layer
 * (src/commands/history.ts), which checks the parameters and reads Git
 * without taking the worktree lock, so neither ever waits behind an execute
 * or integrate.
 *
 * Errors: `INVALID_PARAMS` for a malformed parameter, for a path outside
 * the repository, and for a commit parameter that names no commit
 * (`data: {sha}` / `{before}`) or, for `before`, one that is not on `main`.
 */
import { DEFAULT_HISTORY_PAGE, historyDiff, historyList, type HistoryEntry } from "../../commands/history";
import type { FileDiff } from "../../git/diff";
import { optionalPositiveInt, optionalString, requireString } from "../params";
import type { RequestContext, RpcServer } from "../server";

/** `history.list {path?, limit?=50, before?}` → `HistoryEntry[]`, newest first, on `main`. */
function list(ctx: RequestContext): HistoryEntry[] {
  const path = optionalString(ctx.params, "path");
  const limit = optionalPositiveInt(ctx.params, "limit") ?? DEFAULT_HISTORY_PAGE;
  const before = optionalString(ctx.params, "before");
  return historyList(ctx.server.session.coord, { path, limit, before });
}

/** `history.diff {sha, path?}` → `FileDiff[]`: `sha` against its first parent. */
function diff(ctx: RequestContext): FileDiff[] {
  const sha = requireString(ctx.params, "sha");
  const path = optionalString(ctx.params, "path");
  return historyDiff(ctx.server.session.coord, { sha, path });
}

export function registerHistoryMethods(server: RpcServer): void {
  server.register("history.list", { handler: list });
  server.register("history.diff", { handler: diff });
}
