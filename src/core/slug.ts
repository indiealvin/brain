/**
 * Slug helpers (spec §21–22).
 *
 * `slugKey` is the single case-insensitive normalization used for the shared
 * slug/alias namespace, for link-target resolution, and for ABSENT(slug)
 * precondition checks. Every module that compares slugs or aliases must go
 * through this function so the definitions cannot drift.
 */

/**
 * Normalized namespace key: NFKC → NFD, strip combining marks, lowercase,
 * trim, collapse internal whitespace to single spaces.
 */
export function slugKey(s: string): string {
  return s
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

/** Basename of a repo-relative path without the `.md` extension. */
export function slugFromPath(path: string): string {
  const base = path.replace(/\\/g, "/").replace(/^.*\//, "");
  return base.replace(/\.md$/i, "");
}

/** True when the path names a Markdown note (`*.md`, case-insensitive). */
export function isNotePath(path: string): boolean {
  return /\.md$/i.test(path);
}
