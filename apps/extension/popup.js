// popup.js — connection management for the ATC Knowledge Clipper extension.
//
// Auth flow: the extension never handles credentials. Instead it reads the
// Supabase session cookie that the platform sets after the user signs in with
// their OAuth provider (Google, Microsoft, or Facebook). If no cookie is found
// the user is prompted to open the platform in a tab and sign in there first.

const loadingView = document.getElementById("loading-view");
const connectedView = document.getElementById("connected-view");
const connectView = document.getElementById("connect-view");
const needsSigninView = document.getElementById("needs-signin-view");
const displayPlatformUrl = document.getElementById("display-platform-url");
const signinPlatformUrl = document.getElementById("signin-platform-url");
const tenantUrlInput = document.getElementById("tenant-url");
const connectBtn = document.getElementById("connect-btn");
const connectError = document.getElementById("connect-error");
const disconnectBtn = document.getElementById("disconnect-btn");
const openPlatformBtn = document.getElementById("open-platform-btn");
const recheckBtn = document.getElementById("recheck-btn");
const changeUrlBtn = document.getElementById("change-url-btn");

function show(view) {
  for (const v of [loadingView, connectedView, connectView, needsSigninView]) {
    v.classList.add("hidden");
  }
  view.classList.remove("hidden");
}

function showError(msg) {
  connectError.textContent = msg;
  connectError.classList.remove("hidden");
}

function clearError() {
  connectError.classList.add("hidden");
}

function isTokenExpired(expiresAt) {
  return Date.now() / 1000 >= expiresAt - 60;
}

// Supabase SSR stores the session in cookies named sb-<project-ref>-auth-token.
// Large tokens are split across sb-<project-ref>-auth-token.0, .1, etc.
// The project ref is the first segment of the Supabase project hostname.
function cookieBaseName(supabaseUrl) {
  const ref = new URL(supabaseUrl).hostname.split(".")[0];
  return `sb-${ref}-auth-token`;
}

// Cookie reads need host permission for the tenant origin. The manifest only
// declares optional_host_permissions (no origin is granted by default), so
// each new origin must be requested — this keeps the extension from ever
// holding standing cookie access to sites other than the platform the user
// connected to.
async function ensureHostPermission(tenantUrl, { requestIfMissing }) {
  const origin = `${new URL(tenantUrl).origin}/*`;
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  if (!requestIfMissing) return false;
  return chrome.permissions.request({ origins: [origin] });
}

async function readSupabaseSessionFromCookies(tenantUrl, supabaseUrl) {
  const baseName = cookieBaseName(supabaseUrl);
  const all = await chrome.cookies.getAll({ url: tenantUrl });
  const authCookies = all
    .filter((c) => c.name === baseName || c.name.startsWith(`${baseName}.`))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (authCookies.length === 0) return null;

  const combined = authCookies.map((c) => c.value).join("");
  try {
    return JSON.parse(decodeURIComponent(combined));
  } catch {
    return null;
  }
}

// Attempts to connect to the platform at tenantUrl.
// Returns a session object on success, null if no active platform session exists.
// Throws an Error with a user-facing message on network/config failure.
// requestPermission must be true only when called from a user gesture (chrome.permissions.request
// requires one) — the silent auto-reconnect path on popup load passes false and relies on a
// previously granted permission.
async function tryConnect(tenantUrl, { requestPermission } = { requestPermission: true }) {
  const hasHostPermission = await ensureHostPermission(tenantUrl, { requestIfMissing: requestPermission });
  if (!hasHostPermission) {
    throw new Error("Permission to access that platform was not granted.");
  }

  let configRes;
  try {
    configRes = await fetch(`${tenantUrl}/api/extension/config`);
  } catch {
    throw new Error("Network error. Check your connection and try again.");
  }
  if (!configRes.ok) {
    throw new Error("Could not reach that platform URL. Check the address and try again.");
  }

  // Platform is reachable — persist the URL now so it's pre-filled on next open.
  await chrome.storage.local.set({ tenantUrl });

  const { supabase_url: supabaseUrl, supabase_anon_key: supabaseAnonKey } =
    await configRes.json();

  const parsed = await readSupabaseSessionFromCookies(tenantUrl, supabaseUrl);
  if (!parsed || !parsed.access_token) return null;

  if (isTokenExpired(parsed.expires_at)) {
    const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: supabaseAnonKey },
      body: JSON.stringify({ refresh_token: parsed.refresh_token }),
    });
    if (!res.ok) return null;
    const refreshed = await res.json();
    if (!refreshed.access_token) return null;

    const session = {
      tenantUrl,
      supabaseUrl,
      supabaseAnonKey,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + refreshed.expires_in,
    };
    await chrome.storage.local.set({ session, tenantUrl });
    return session;
  }

  const session = {
    tenantUrl,
    supabaseUrl,
    supabaseAnonKey,
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresAt: parsed.expires_at,
  };
  await chrome.storage.local.set({ session, tenantUrl });
  return session;
}

async function init() {
  const stored = await chrome.storage.local.get(["session", "tenantUrl"]);

  // Fast path: non-expired stored session.
  if (stored.session && !isTokenExpired(stored.session.expiresAt)) {
    displayPlatformUrl.textContent = stored.session.tenantUrl;
    show(connectedView);
    return;
  }

  // Determine the best URL to pre-populate. Priority:
  //   1. Stored session URL (may be expired, still the right URL to reconnect).
  //   2. Previously-saved tenantUrl (user connected before but disconnected).
  //   3. Active tab URL (auto-detect if the user is on the platform right now).
  let candidateUrl = stored.session?.tenantUrl ?? stored.tenantUrl ?? null;

  if (!candidateUrl) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url) {
        const u = new URL(tab.url);
        if (u.protocol === "https:") candidateUrl = `${u.protocol}//${u.host}`;
      }
    } catch {
      // Tabs query failed — proceed without pre-fill.
    }
  }

  if (!candidateUrl) {
    show(connectView);
    return;
  }

  tenantUrlInput.value = candidateUrl;

  // If we had a stored session try a token refresh before hitting cookies.
  if (stored.session) {
    try {
      const res = await fetch(
        `${stored.session.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: stored.session.supabaseAnonKey,
          },
          body: JSON.stringify({ refresh_token: stored.session.refreshToken }),
        },
      );
      if (res.ok) {
        const data = await res.json();
        if (data.access_token) {
          const refreshed = {
            ...stored.session,
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
          };
          await chrome.storage.local.set({ session: refreshed });
          displayPlatformUrl.textContent = refreshed.tenantUrl;
          show(connectedView);
          return;
        }
      }
    } catch {
      // Refresh failed — fall through to cookie detection.
    }
    await chrome.storage.local.remove("session");
  }

  // Try to read the Supabase session cookie from the platform domain. Popup-load is not a
  // user gesture chrome.permissions.request can use, so only proceed if permission was
  // already granted from a prior explicit Connect click.
  try {
    const result = await tryConnect(candidateUrl, { requestPermission: false });
    if (result) {
      displayPlatformUrl.textContent = candidateUrl;
      show(connectedView);
      return;
    }
  } catch {
    // Config fetch failed (wrong URL or offline) — show connect form pre-filled.
    show(connectView);
    return;
  }

  // Cookie not found: prompt sign-in.
  signinPlatformUrl.textContent = candidateUrl;
  show(needsSigninView);
}

connectBtn.addEventListener("click", async () => {
  clearError();
  const tenantUrl = tenantUrlInput.value.trim().replace(/\/$/, "");
  if (!tenantUrl) {
    showError("Enter your platform URL.");
    return;
  }
  try {
    const u = new URL(tenantUrl);
    if (u.protocol !== "https:") throw new Error();
  } catch {
    showError("Enter a valid https:// URL.");
    return;
  }

  connectBtn.disabled = true;
  connectBtn.textContent = "Connecting…";

  try {
    const result = await tryConnect(tenantUrl);
    if (result === null) {
      signinPlatformUrl.textContent = tenantUrl;
      show(needsSigninView);
      return;
    }
    displayPlatformUrl.textContent = tenantUrl;
    show(connectedView);
  } catch (err) {
    showError(err instanceof Error ? err.message : "Connection failed.");
  } finally {
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect";
  }
});

openPlatformBtn.addEventListener("click", async () => {
  const stored = await chrome.storage.local.get("tenantUrl");
  if (stored.tenantUrl) chrome.tabs.create({ url: stored.tenantUrl });
});

recheckBtn.addEventListener("click", async () => {
  const stored = await chrome.storage.local.get("tenantUrl");
  if (!stored.tenantUrl) {
    show(connectView);
    return;
  }

  recheckBtn.disabled = true;
  recheckBtn.textContent = "Checking…";

  try {
    const result = await tryConnect(stored.tenantUrl);
    if (result) {
      displayPlatformUrl.textContent = stored.tenantUrl;
      show(connectedView);
    } else {
      signinPlatformUrl.textContent = stored.tenantUrl;
      show(needsSigninView);
    }
  } catch {
    // Leave on needs-signin view.
  } finally {
    recheckBtn.disabled = false;
    recheckBtn.textContent = "I've signed in — connect";
  }
});

changeUrlBtn.addEventListener("click", () => {
  show(connectView);
});

disconnectBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove("session");
  show(connectView);
});

init();
