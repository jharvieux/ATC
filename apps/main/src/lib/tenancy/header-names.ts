// Header names emitted by proxy.ts that downstream code reads to resolve
// the active tenant. Centralized so the literal `"x-resolved-tenant-id"`
// isn't redeclared in every consumer — a typo'd copy would silently
// skip tenant scoping in that one place.

/** Resolved tenant id set by `apps/main/src/proxy.ts` on every inbound
 *  request. Value is a tenant UUID, the literal "platform" sentinel on
 *  the platform domain, or absent on requests middleware doesn't touch.
 *  proxy.ts strips any attacker-supplied value before re-setting, so
 *  callers can trust the header. */
export const RESOLVED_TENANT_ID_HEADER = "x-resolved-tenant-id";
