// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_URL = "https://tenant.aitravelconcierge.com/settings/profile";
const ORIGIN_PATTERN = `${new URL(TENANT_URL).origin}/*`;
const SUPABASE_URL = "https://project.supabase.co";

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

function configResponse() {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({
      supabase_url: SUPABASE_URL,
      supabase_anon_key: "anon-key",
    }),
  };
}

function sessionCookie() {
  return {
    name: "sb-project-auth-token",
    value: encodeURIComponent(
      JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    ),
  };
}

function stubPopup({
  storedTenantUrl = null,
  contains = [],
  requests = [],
  cookies = [],
}: {
  storedTenantUrl?: string | null;
  contains?: boolean[];
  requests?: boolean[];
  cookies?: object[][];
}) {
  const containsPermission = vi.fn();
  for (const result of contains) containsPermission.mockResolvedValueOnce(result);
  const requestPermission = vi.fn();
  for (const result of requests) requestPermission.mockResolvedValueOnce(result);
  const getCookies = vi.fn();
  for (const result of cookies) getCookies.mockResolvedValueOnce(result);
  const getStorage = vi.fn().mockImplementation(async (key) => {
    if (Array.isArray(key)) return storedTenantUrl ? { tenantUrl: storedTenantUrl } : {};
    if (key === "tenantUrl") return storedTenantUrl ? { tenantUrl: storedTenantUrl } : {};
    return {};
  });
  const fetchStub = vi.fn().mockImplementation(async () => configResponse());

  vi.stubGlobal("chrome", {
    permissions: { contains: containsPermission, request: requestPermission },
    storage: { local: { get: getStorage, set: vi.fn(), remove: vi.fn() } },
    cookies: { getAll: getCookies },
    tabs: { query: vi.fn().mockResolvedValue([]), create: vi.fn() },
  });
  vi.stubGlobal("fetch", fetchStub);
  return { containsPermission, fetchStub, getCookies, requestPermission };
}

async function loadPopup() {
  await import("../../../apps/extension/popup.js");
}

function view(id: string) {
  return document.getElementById(id) as HTMLElement;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  renderPopup();
});

describe("popup host-permission gestures", () => {
  it("shows Connect without requesting or fetching when silent reconnect lacks permission", async () => {
    const stubs = stubPopup({ storedTenantUrl: TENANT_URL, contains: [false] });

    await loadPopup();
    await vi.waitFor(() => expect(view("connect-view").classList.contains("hidden")).toBe(false));

    expect(stubs.containsPermission).toHaveBeenCalledWith({ origins: [ORIGIN_PATTERN] });
    expect(stubs.requestPermission).not.toHaveBeenCalled();
    expect(stubs.fetchStub).not.toHaveBeenCalled();
  });

  it("silently reconnects when the exact tenant-origin permission already exists", async () => {
    const stubs = stubPopup({ storedTenantUrl: TENANT_URL, contains: [true], cookies: [[sessionCookie()]] });

    await loadPopup();
    await vi.waitFor(() => expect(view("connected-view").classList.contains("hidden")).toBe(false));

    expect(stubs.containsPermission).toHaveBeenCalledWith({ origins: [ORIGIN_PATTERN] });
    expect(stubs.requestPermission).not.toHaveBeenCalled();
    expect(stubs.fetchStub).toHaveBeenCalledTimes(1);
  });

  it("surfaces Connect denial without fetching and requests only the tenant origin", async () => {
    const stubs = stubPopup({ contains: [false], requests: [false] });
    await loadPopup();
    const input = document.getElementById("tenant-url") as HTMLInputElement;
    input.value = TENANT_URL;

    view("connect-btn").click();
    await vi.waitFor(() => expect(view("connect-error").textContent).toBe("Permission to access that platform was not granted."));

    expect(stubs.containsPermission).toHaveBeenCalledWith({ origins: [ORIGIN_PATTERN] });
    expect(stubs.requestPermission).toHaveBeenCalledWith({ origins: [ORIGIN_PATTERN] });
    expect(stubs.fetchStub).not.toHaveBeenCalled();
  });

  it("continues Connect to the connected view after permission is granted", async () => {
    const stubs = stubPopup({ contains: [false], requests: [true], cookies: [[sessionCookie()]] });
    await loadPopup();
    const input = document.getElementById("tenant-url") as HTMLInputElement;
    input.value = TENANT_URL;

    view("connect-btn").click();
    await vi.waitFor(() => expect(view("connected-view").classList.contains("hidden")).toBe(false));

    expect(stubs.containsPermission).toHaveBeenCalledWith({ origins: [ORIGIN_PATTERN] });
    expect(stubs.requestPermission).toHaveBeenCalledWith({ origins: [ORIGIN_PATTERN] });
    expect(stubs.fetchStub).toHaveBeenCalledTimes(1);
  });

  it("handles Recheck denial from needs-signin without a second fetch", async () => {
    const stubs = stubPopup({ storedTenantUrl: TENANT_URL, contains: [true, false], requests: [false], cookies: [[]] });
    await loadPopup();
    await vi.waitFor(() => expect(view("needs-signin-view").classList.contains("hidden")).toBe(false));

    const recheck = view("recheck-btn") as HTMLButtonElement;
    recheck.click();
    await vi.waitFor(() => expect(stubs.requestPermission).toHaveBeenCalled());
    await vi.waitFor(() => expect(recheck.disabled).toBe(false));

    expect(stubs.containsPermission).toHaveBeenNthCalledWith(1, { origins: [ORIGIN_PATTERN] });
    expect(stubs.containsPermission).toHaveBeenNthCalledWith(2, { origins: [ORIGIN_PATTERN] });
    expect(stubs.requestPermission).toHaveBeenCalledWith({ origins: [ORIGIN_PATTERN] });
    expect(stubs.fetchStub).toHaveBeenCalledTimes(1);
  });

  it("continues Recheck to the connected view after permission is granted", async () => {
    const stubs = stubPopup({
      storedTenantUrl: TENANT_URL,
      contains: [true, false],
      requests: [true],
      cookies: [[], [sessionCookie()]],
    });
    await loadPopup();
    await vi.waitFor(() => expect(view("needs-signin-view").classList.contains("hidden")).toBe(false));

    view("recheck-btn").click();
    await vi.waitFor(() => expect(view("connected-view").classList.contains("hidden")).toBe(false));

    expect(stubs.containsPermission).toHaveBeenNthCalledWith(1, { origins: [ORIGIN_PATTERN] });
    expect(stubs.containsPermission).toHaveBeenNthCalledWith(2, { origins: [ORIGIN_PATTERN] });
    expect(stubs.requestPermission).toHaveBeenCalledWith({ origins: [ORIGIN_PATTERN] });
    expect(stubs.fetchStub).toHaveBeenCalledTimes(2);
  });
});
