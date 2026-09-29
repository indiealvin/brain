/**
 * Identifiers (spec §7.1, §18).
 *
 * ULIDs: 26 chars of Crockford base32, 48-bit ms timestamp + 80 random bits.
 * Monotonic within a process: ids generated in the same millisecond strictly
 * increase, so sort order equals creation order.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let t = now;
  let out = "";
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomDigits(): number[] {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b % 32);
}

function incrementDigits(digits: number[]): number[] {
  const out = digits.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 31) {
      out[i] = out[i]! + 1;
      return out;
    }
    out[i] = 0;
  }
  // Overflow within one ms is astronomically unlikely; fall back to fresh randomness.
  return randomDigits();
}

export function ulid(now: number = Date.now()): string {
  let digits: number[];
  if (now === lastTime) {
    digits = incrementDigits(lastRandom);
  } else {
    digits = randomDigits();
  }
  lastTime = now;
  lastRandom = digits;
  return encodeTime(now) + digits.map((d) => ENCODING[d]!).join("");
}

export const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function isUlid(s: string): boolean {
  return ULID_RE.test(s);
}

export const MUTATION_ID_PREFIX = "mut_";

export function mutationId(): string {
  return MUTATION_ID_PREFIX + ulid();
}

export function isMutationId(s: string): boolean {
  return s.startsWith(MUTATION_ID_PREFIX) && isUlid(s.slice(MUTATION_ID_PREFIX.length));
}

export function noteId(): string {
  return ulid();
}

export function proposalId(): string {
  return "prop_" + ulid();
}
