// BP32 §32.10.7 — GitHub webhook signature verification.
//
// GitHub Apps sign every webhook with HMAC-SHA256 over the raw body using
// the App's webhook secret, sent as `x-hub-signature-256: sha256=<hex>`.
// Fail-closed on a missing or malformed signature. The comparison is
// timing-safe to avoid leaking the expected digest byte-by-byte.

import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGitHubSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !signature.startsWith("sha256=")) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
