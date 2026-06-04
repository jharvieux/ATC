// Lock down the two null-fast inputs (null id, "platform" sentinel) so
// a regression to those branches can't silently send platform-domain
// requests through a needless service-role query.

import { describe, it, expect } from "vitest";
import { fetchTenantBranding } from "@/lib/branding/fetch-tenant-branding";

describe("fetchTenantBranding", () => {
  it("returns null for a null tenant id (anonymous / unresolved)", async () => {
    // Why: an absent x-resolved-tenant-id header means we couldn't
    // figure out who the caller is talking to. Defaulting to the
    // platform hero is the safe fallback.
    const result = await fetchTenantBranding(null);
    expect(result).toBeNull();
  });

  it("returns null for the 'platform' sentinel (set by proxy.ts on the platform domain)", async () => {
    // Why: proxy.ts emits the literal string "platform" when no tenant
    // subdomain resolved. If this branch ever stopped firing, every
    // platform-domain request would do an extra service-role query +
    // return no rows, masquerading as a perf bug.
    const result = await fetchTenantBranding("platform");
    expect(result).toBeNull();
  });
});
