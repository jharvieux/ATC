import "server-only";

import { matchesRotatingSecret } from "@/lib/auth/rotating-secret";

// #2002 / D-091 #28 — the MAIN_APP_ADMIN_API_KEY rotation set. The rag crons
// send whichever key they hold; main accepts _CURRENT and _PREVIOUS (plus the
// legacy single var until the operator rotates onto the pair) so a suspected
// leak can be rotated out with zero seam downtime.
export function adminApiKeySecrets(): string[] {
  return [
    process.env.MAIN_APP_ADMIN_API_KEY_CURRENT,
    process.env.MAIN_APP_ADMIN_API_KEY_PREVIOUS,
    process.env.MAIN_APP_ADMIN_API_KEY,
  ].filter((s): s is string => !!s);
}

export function matchesAdminApiKey(token: string): boolean {
  return matchesRotatingSecret(token, adminApiKeySecrets());
}
