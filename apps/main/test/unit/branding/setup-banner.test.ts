// Guards the tenant-scoped localStorage key format used by
// BrandingSetupBannerClient. The business rule being tested: dismissing
// the banner for tenant A must not suppress it for tenant B. A future
// refactor that collapses `tenantId` out of the key (e.g. a constant
// string like "branding-setup-dismissed") would cause every subsequent
// tenant to see a blank canvas — this test would catch that regression
// before it shipped.

import { describe, it, expect } from "vitest";
import { brandingSetupDismissedKey } from "@/components/branding-setup-banner/BrandingSetupBannerClient";

describe("brandingSetupDismissedKey — tenant-scoped localStorage key (#965)", () => {
  it("embeds the tenantId in the key so dismissal cannot cross tenant boundaries", () => {
    // Why: if the key didn't include tenantId, one tenant owner dismissing
    // the banner would hide it for ALL tenant owners — nobody else would
    // ever see the branding prompt again.
    const key = brandingSetupDismissedKey("tenant-abc-123");
    expect(key).toBe("branding-setup-dismissed-tenant-abc-123");
  });

  it("produces distinct keys for different tenants", () => {
    const keyA = brandingSetupDismissedKey("tenant-alpha");
    const keyB = brandingSetupDismissedKey("tenant-beta");
    expect(keyA).not.toBe(keyB);
  });

  it("preserves the full tenantId, including UUID-shaped values", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const key = brandingSetupDismissedKey(uuid);
    expect(key).toBe(`branding-setup-dismissed-${uuid}`);
    expect(key).toContain(uuid);
  });
});
