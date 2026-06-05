// popup.js — handles the sign-in form and signed-in status display.

const loadingView = document.getElementById("loading-view");
const signedInView = document.getElementById("signed-in-view");
const signedOutView = document.getElementById("signed-out-view");
const displayTenantUrl = document.getElementById("display-tenant-url");
const tenantUrlInput = document.getElementById("tenant-url");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const signInBtn = document.getElementById("sign-in-btn");
const signOutBtn = document.getElementById("sign-out-btn");
const errorMsg = document.getElementById("error-msg");

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove("hidden");
}

function clearError() {
  errorMsg.classList.add("hidden");
  errorMsg.textContent = "";
}

function show(view) {
  loadingView.classList.add("hidden");
  signedInView.classList.add("hidden");
  signedOutView.classList.add("hidden");
  view.classList.remove("hidden");
}

function isTokenExpired(expiresAt) {
  return Date.now() / 1000 >= expiresAt - 60;
}

async function refreshSession(session) {
  const res = await fetch(
    `${session.supabaseUrl}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: session.supabaseAnonKey,
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    },
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;
  return {
    ...session,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
  };
}

async function init() {
  const stored = await chrome.storage.local.get("session");
  const session = stored.session;

  if (!session) {
    show(signedOutView);
    return;
  }

  if (isTokenExpired(session.expiresAt)) {
    const refreshed = await refreshSession(session);
    if (!refreshed) {
      await chrome.storage.local.remove("session");
      show(signedOutView);
      return;
    }
    await chrome.storage.local.set({ session: refreshed });
    displayTenantUrl.textContent = refreshed.tenantUrl;
  } else {
    displayTenantUrl.textContent = session.tenantUrl;
  }

  show(signedInView);
}

signInBtn.addEventListener("click", async () => {
  clearError();
  const tenantUrl = tenantUrlInput.value.trim().replace(/\/$/, "");
  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!tenantUrl || !email || !password) {
    showError("All fields are required.");
    return;
  }

  signInBtn.disabled = true;
  signInBtn.textContent = "Signing in…";

  try {
    // Discover Supabase config from the platform.
    const configRes = await fetch(`${tenantUrl}/api/extension/config`);
    if (!configRes.ok) {
      showError("Could not reach that platform URL. Check the address and try again.");
      return;
    }
    const { supabase_url: supabaseUrl, supabase_anon_key: supabaseAnonKey } =
      await configRes.json();

    // Sign in via Supabase password grant.
    const authRes = await fetch(
      `${supabaseUrl}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: supabaseAnonKey,
        },
        body: JSON.stringify({ email, password }),
      },
    );
    const authData = await authRes.json();
    if (!authRes.ok || !authData.access_token) {
      showError(authData.error_description ?? authData.message ?? "Sign in failed.");
      return;
    }

    const session = {
      tenantUrl,
      supabaseUrl,
      supabaseAnonKey,
      accessToken: authData.access_token,
      refreshToken: authData.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + authData.expires_in,
    };
    await chrome.storage.local.set({ session });

    displayTenantUrl.textContent = tenantUrl;
    show(signedInView);
  } catch (err) {
    showError("Network error. Check your connection and try again.");
  } finally {
    signInBtn.disabled = false;
    signInBtn.textContent = "Sign in";
  }
});

signOutBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove("session");
  tenantUrlInput.value = "";
  emailInput.value = "";
  passwordInput.value = "";
  show(signedOutView);
});

init();
