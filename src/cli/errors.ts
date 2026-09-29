/**
 * `CliError`: a user-facing failure with an exit code. Lives in its own
 * module so the command modules under src/cli/ can throw it without
 * importing the entry point (src/cli.ts) and creating an import cycle.
 */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}
