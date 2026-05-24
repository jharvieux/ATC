/**
 * BP31 §32.7.1 — GitHub App authentication.
 *
 * The platform authenticates to GitHub as a GitHub App (not a PAT) per the
 * spec rationale: per-installation scoping, fine-grained permissions
 * (Issues R/W only — no PRs, Contents, Actions), audit trail, and rotation
 * without an individual's credentials in play.
 *
 * `getInstallationToken()` returns a short-lived installation access token.
 * The token is cached in-process for 50 minutes (GitHub installation tokens
 * live for 1 hour; we refresh 10 minutes early to avoid an in-flight call
 * landing on an expired token). Never persisted to disk or DB.
 *
 * No-direct-octokit-import lint rule (`atc/no-direct-octokit-import`)
 * restricts `@octokit/*` imports to this file and `apps/main/src/lib/github/issues.ts`.
 * Other callers go through those two wrappers.
 */

import { createAppAuth } from "@octokit/auth-app";
import { env } from "@/lib/env";

interface CachedToken {
  token: string;
  expires_at_ms: number;
}

let _cached: CachedToken | null = null;

const REFRESH_LEAD_MS = 10 * 60 * 1000; // refresh 10 min before expiry

/**
 * Returns a valid installation access token. Reads through the in-process
 * cache when possible; mints a fresh one when missing or near expiry.
 *
 * Throws if the GitHub App credentials cannot mint a token — caller
 * (issues.ts) catches and surfaces the resilience path (§32.7.5).
 */
export async function getInstallationToken(): Promise<string> {
  const now = Date.now();
  if (_cached && _cached.expires_at_ms - REFRESH_LEAD_MS > now) {
    return _cached.token;
  }

  const e = env();
  const auth = createAppAuth({
    appId: e.GITHUB_APP_ID,
    privateKey: e.GITHUB_APP_PRIVATE_KEY,
    installationId: e.GITHUB_APP_INSTALLATION_ID,
  });

  const result = (await auth({ type: "installation" })) as {
    token: string;
    expiresAt: string;
  };

  _cached = {
    token: result.token,
    expires_at_ms: Date.parse(result.expiresAt),
  };
  return _cached.token;
}

/** Test helper — clears the cache so a unit test can force a re-mint. */
export function _resetInstallationTokenCacheForTests(): void {
  _cached = null;
}
