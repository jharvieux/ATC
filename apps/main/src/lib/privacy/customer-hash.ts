// §25.4 / §25.4a — Deterministic customer-hash derivation.
//
// Same (user_id, tenant_id, PLATFORM_PEPPER) → same hash, every time.
// The hash MUST be deterministic so the same value lands on bookings,
// commissions, and contacts.notes anonymization for one customer.
//
// PLATFORM_PEPPER is set ONCE at platform genesis and NEVER rotated.
// Rotating it would orphan every existing anonymized row from its
// hash-derived placeholder — there is no migration path. The /admin
// runbook documents the vault entry name.

import { createHash } from "node:crypto";

const TENANT_PLACEHOLDER = "PLATFORM"; // matches spec wording

export function deriveCustomerHash(
  user_id: string,
  tenant_id: string | null,
): string {
  const pepper = process.env.PLATFORM_PEPPER;
  if (!pepper) {
    throw new Error("deriveCustomerHash: PLATFORM_PEPPER not configured.");
  }
  const composite = `${user_id}|${tenant_id ?? TENANT_PLACEHOLDER}|${pepper}`;
  const buf = createHash("sha256").update(composite).digest();
  // base64url (no padding) is URL-safe and shorter than hex.
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
    .slice(0, 32);
}
