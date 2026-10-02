/**
 * Params validation for RPC methods. Each helper reads one field and throws
 * `INVALID_PARAMS` naming the field when it has the wrong type. Unknown
 * fields are never inspected, so they are ignored (protocol §2).
 */
import { PROVIDER_ENV_KEYS, type ProviderEnv, type ProviderEnvKey } from "./dto";
import { invalidParams } from "./errors";

export type Params = Record<string, unknown>;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function requireString(p: Params, field: string): string {
  const v = p[field];
  if (typeof v !== "string" || v === "") throw invalidParams(`${field} is required and must be a non-empty string`);
  return v;
}

export function optionalString(p: Params, field: string): string | undefined {
  const v = p[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v === "") throw invalidParams(`${field} must be a non-empty string`);
  return v;
}

export function optionalBoolean(p: Params, field: string): boolean | undefined {
  const v = p[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw invalidParams(`${field} must be a boolean`);
  return v;
}

export function optionalObject(p: Params, field: string): Params | undefined {
  const v = p[field];
  if (v === undefined || v === null) return undefined;
  if (!isPlainObject(v)) throw invalidParams(`${field} must be an object`);
  return v;
}

export function optionalPositiveInt(p: Params, field: string, label = field): number | undefined {
  const v = p[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw invalidParams(`${label} must be a positive integer`);
  return v;
}

/**
 * `initialize.env` / `doctor.run.env`: string values for allowlisted keys
 * only (`ProviderEnvKey`, protocol §3). A key outside the allowlist is
 * rejected rather than dropped: it is never meaningful to the server, and a
 * misspelled key silently ignored would surface much later as `NO_MODEL`.
 * Error messages name keys, never values.
 */
export function providerEnvParam(p: Params, field = "env"): ProviderEnv {
  const v = optionalObject(p, field);
  if (v === undefined) return {};
  const unknown = Object.keys(v).filter((k) => !(PROVIDER_ENV_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) throw invalidParams(`${field} accepts only ${PROVIDER_ENV_KEYS.join(", ")}; got ${unknown.join(", ")}`);
  const env: ProviderEnv = {};
  for (const [k, value] of Object.entries(v)) {
    if (typeof value !== "string") throw invalidParams(`${field}.${k} must be a string`);
    env[k as ProviderEnvKey] = value;
  }
  return env;
}
