// Shared e2e helpers — env-driven fixture IDs + valid Bearer headers.

export const BYPASS = process.env.TEST_AUTH_BYPASS_TOKEN ?? "tier2-local-test-secret";
export const TENANT = process.env.TEST_AUTH_BYPASS_TENANT_ID ?? "22222222-0000-0000-0000-0000000000a1";
export const CONTACT_ID = "c0000000-0000-0000-0000-0000000000c1";

export const HEADERS = {
  Authorization: `Bearer ${BYPASS}`,
  "x-resolved-tenant-id": TENANT,
  "Content-Type": "application/json",
} as const;

export const HEADERS_NO_AUTH = {
  "x-resolved-tenant-id": TENANT,
  "Content-Type": "application/json",
} as const;
