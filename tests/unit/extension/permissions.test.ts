// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_URL = "https://tenant.aitravelconcierge.com/settings/profile";
const ORIGIN_PATTERN = "https://tenant.aitravelconcierge.com/*";

function renderPopup() {
  document.body.innerHTML = `
    <div id="loading-view"></div>
    <div id="connected-view" class="hidden"></div>
    <div id="connect-view" class="hidden"></div>
    <div id="needs-signin-view" class="hidden"></div>
    <div id="display-platform-url"></div>
    <div id="signin-platform-url"></div>
    <input id="tenant-url" />
    <button id="connect-btn"></button>
    <div id="connect-error" class="hidden"></div>
    <button id="disconnect-btn"></button>
    <button id="open-platform-btn"></button>
    <button id="recheck-btn"></button>
    <button id="change-url-btn"></button>
  `;
}

function stubChrome(storedTenantUrl: string | null) {
  const contains = vi.fn().mockResolvedValue(false);
  const request = vi.fn().mockResolvedValue(false);
  const get = vi.fn().mockImplementation(async (key) => {
    if (Array.isArray(key)) return storedTenantUrl ? { tenantUrl: storedTenantUrl } : {};
    if (key === "tenantUrl") return storedTenantUrl ? { tenantUrl: storedTenantUrl } : {};
    return {};
  });
  vi.stubGlobal("chrome", {
    permissions: { contains, request },
    storage: { local: { get, set: vi.fn(), remove: vi.fn() } },
    cookies: { getAll: vi.fn() },
    tabs: { query: vi.fn().mockResolvedValue([]), create: vi.fn() },
  });
  vi.stubGlobal("fetch", vi.fn());
  return { contains, get, request };
}

async function loadPopup() {
  await import("../../../apps/extension/popup.js");
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  renderPopup();
});

describe("popup host-permission gestures", () => {
  it("never requests permission during the actual silent popup-load reconnect", async () => {
    const permissions = stubChrome(TENANT_URL);

    await loadPopup();
    await vi.waitFor(() => expect(permissions.contains).toHaveBeenCalled());

    expect(permissions.contains).toHaveBeenCalledWith({ origins: [ORIGIN_PATTERN] });
    expect(permissions.request).not.toHaveBeenCalled();
  });

  it("requests origin-scoped permission from the actual Connect click and surfaces denial", async () => {
    const permissions = stubChrome(null);
    await loadPopup();
    const tenantUrlInput = document.getElementById("tenant-url") as HTMLInputElement;
    const connectButton = document.getElementById("connect-btn") as HTMLButtonElement;
    const connectError = document.getElementById("connect-error");

    tenantUrlInput.value = TENANT_URL;
    connectButton.click();
    await vi.waitFor(() => expect(permissions.request).toHaveBeenCalled());

    expect(permissions.request).toHaveBeenCalledWith({ origins: [ORIGIN_PATTERN] });
    expect(connectError?.textContent).toBe("Permission to access that platform was not granted.");
  });

  it("requests origin-scoped permission from the actual Recheck click and handles denial", async () => {
    const permissions = stubChrome(TENANT_URL);
    permissions.get.mockImplementation(async (key) => {
      if (Array.isArray(key)) return {};
      return key === "tenantUrl" ? { tenantUrl: TENANT_URL } : {};
    });
    await loadPopup();
    const recheckButton = document.getElementById("recheck-btn") as HTMLButtonElement;

    recheckButton.click();
    await vi.waitFor(() => expect(permissions.request).toHaveBeenCalled());

    expect(permissions.request).toHaveBeenCalledWith({ origins: [ORIGIN_PATTERN] });
    await vi.waitFor(() => expect(recheckButton.disabled).toBe(false));
  });
});
