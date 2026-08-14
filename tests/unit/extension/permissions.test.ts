import { describe, expect, it, vi } from "vitest";
import { ensureHostPermission } from "../../../apps/extension/permissions.js";

function permissionsStub(containsResult: boolean, requestResult = true) {
  return {
    contains: vi.fn().mockResolvedValue(containsResult),
    request: vi.fn().mockResolvedValue(requestResult),
  };
}

describe("ensureHostPermission", () => {
  it("never requests permission during a silent popup-load reconnect", async () => {
    const permissions = permissionsStub(false);

    await expect(
      ensureHostPermission("https://tenant.aitravelconcierge.com", { requestIfMissing: false }, permissions),
    ).resolves.toBe(false);

    expect(permissions.contains).toHaveBeenCalledWith({ origins: ["https://tenant.aitravelconcierge.com/*"] });
    expect(permissions.request).not.toHaveBeenCalled();
  });

  it("requests missing permission when an explicit Connect or Recheck action allows it", async () => {
    const permissions = permissionsStub(false);

    await expect(
      ensureHostPermission("https://tenant.aitravelconcierge.com", { requestIfMissing: true }, permissions),
    ).resolves.toBe(true);

    expect(permissions.request).toHaveBeenCalledWith({ origins: ["https://tenant.aitravelconcierge.com/*"] });
  });

  it("scopes the requested permission to the tenant origin, not a supplied path", async () => {
    const permissions = permissionsStub(false);

    await ensureHostPermission("https://tenant.aitravelconcierge.com/settings/profile", { requestIfMissing: true }, permissions);

    expect(permissions.request).toHaveBeenCalledWith({ origins: ["https://tenant.aitravelconcierge.com/*"] });
  });

  it("does not request an origin that was already granted", async () => {
    const permissions = permissionsStub(true);

    await expect(
      ensureHostPermission("https://tenant.aitravelconcierge.com", { requestIfMissing: true }, permissions),
    ).resolves.toBe(true);

    expect(permissions.request).not.toHaveBeenCalled();
  });
});
