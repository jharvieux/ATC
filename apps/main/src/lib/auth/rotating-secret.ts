import { constantTimeEqual } from "@/lib/auth/constant-time-equal";

// D-091 #28 — accept any configured member of a secret's rotation set
// (_CURRENT, _PREVIOUS, plus the legacy single var during transition).
// Compares against every configured value instead of returning on the first
// match so which slot matched doesn't leak via timing. Fail-closed: an empty
// token or a fully-unset rotation set matches nothing.
export function matchesRotatingSecret(
  token: string,
  secrets: readonly (string | undefined)[],
): boolean {
  if (!token) return false;
  let ok = false;
  for (const secret of secrets) {
    if (secret && constantTimeEqual(token, secret)) ok = true;
  }
  return ok;
}
