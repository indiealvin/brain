/**
 * Secret redaction for the RPC server (docs/mac-app/design.md §10): API keys
 * and tokens are scrubbed from every log line (the server's own, relayed
 * library output on stderr) and from every error message sent to the client.
 *
 * The redactor learns secrets from every environment the server builds or
 * inherits: the process environment at startup, `initialize.env`,
 * `doctor.run.env` and `$BRAIN_HOME/config.toml`. It only ever grows.
 */
import { SECRET_ENV_KEYS } from "./dto";

export const REDACTED = "[redacted]";

/** Values shorter than this are not treated as secrets: replacing them would mangle ordinary text. */
const MIN_SECRET_LENGTH = 4;

export class Redactor {
  private readonly secrets = new Set<string>();
  /** Longest first, so a secret that contains another is replaced whole. */
  private ordered: string[] = [];

  /** Remember `value` (trimmed, as the providers use it) as a secret. */
  add(value: string | undefined): void {
    const v = value?.trim();
    if (v === undefined || v.length < MIN_SECRET_LENGTH || this.secrets.has(v)) return;
    this.secrets.add(v);
    this.ordered = [...this.secrets].sort((a, b) => b.length - a.length);
  }

  /** Remember the credential values of `env` (`SECRET_ENV_KEYS`). */
  addFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): void {
    for (const k of SECRET_ENV_KEYS) this.add(env[k]);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.ordered) if (out.includes(s)) out = out.split(s).join(REDACTED);
    return out;
  }

  /** `redact` every string (object keys untouched) of a JSON value, e.g. a notification's data. A copy; `value` is not changed. */
  redactDeep<T>(value: T): T {
    if (this.ordered.length === 0) return value;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return this.redact(v);
      if (Array.isArray(v)) return v.map(walk);
      if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return walk(value) as T;
  }
}
