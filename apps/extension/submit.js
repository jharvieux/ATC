// submit.js — handles the context-menu-triggered submission popup.

const mainView = document.getElementById("main-view");
const successView = document.getElementById("success-view");
const notSignedInView = document.getElementById("not-signed-in-view");
const contentEl = document.getElementById("content");
const charCountEl = document.getElementById("char-count");
const sourceUrlEl = document.getElementById("source-url");
const pageTitleEl = document.getElementById("page-title");
const submitBtn = document.getElementById("submit-btn");
const cancelBtn = document.getElementById("cancel-btn");
const errorMsg = document.getElementById("error-msg");

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove("hidden");
}

function clearError() {
  errorMsg.classList.add("hidden");
}

async function getValidSession() {
  const stored = await chrome.storage.local.get("session");
  const session = stored.session;
  if (!session) return null;

  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec < session.expiresAt - 60) return session;

  // Token expired — attempt refresh. No host permission is requested for
  // supabaseUrl — GoTrue's CORS handler (supabase/auth) allows all origins by
  // design (anon key + JWT are the real auth boundary, not CORS). See "Trust
  // boundary: Supabase auth fetches" in docs/browser-extension.md.
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
  if (!res.ok) {
    await chrome.storage.local.remove("session");
    return null;
  }
  const data = await res.json();
  if (!data.access_token) {
    await chrome.storage.local.remove("session");
    return null;
  }
  const refreshed = {
    ...session,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: nowSec + data.expires_in,
  };
  await chrome.storage.local.set({ session: refreshed });
  return refreshed;
}

async function init() {
  const session = await getValidSession();
  if (!session) {
    mainView.classList.add("hidden");
    notSignedInView.classList.remove("hidden");
    return;
  }

  const stored = await chrome.storage.session.get("pendingSubmit");
  const pending = stored.pendingSubmit;
  if (pending) {
    contentEl.value = pending.selection ?? "";
    sourceUrlEl.value = pending.url ?? "";
    pageTitleEl.value = pending.title ?? "";
    charCountEl.textContent = contentEl.value.length;
    await chrome.storage.session.remove("pendingSubmit");
  }
}

contentEl.addEventListener("input", () => {
  charCountEl.textContent = contentEl.value.length;
});

cancelBtn.addEventListener("click", () => window.close());

submitBtn.addEventListener("click", async () => {
  clearError();
  const content = contentEl.value.trim();
  if (!content) {
    showError("Content cannot be empty.");
    return;
  }

  const session = await getValidSession();
  if (!session) {
    mainView.classList.add("hidden");
    notSignedInView.classList.remove("hidden");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";

  try {
    const res = await fetch(`${session.tenantUrl}/api/rag/submit/extension`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        selection: content,
        url: sourceUrlEl.value.trim() || undefined,
        page_title: pageTitleEl.value.trim() || undefined,
      }),
    });

    if (res.status === 401 || res.status === 403) {
      showError("Session expired. Please sign in again via the extension icon.");
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showError(data.error ?? `Submission failed (${res.status}).`);
      return;
    }

    mainView.classList.add("hidden");
    successView.classList.remove("hidden");
    setTimeout(() => window.close(), 2500);
  } catch {
    showError("Network error. Check your connection and try again.");
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit to Knowledge Base";
  }
});

init();
