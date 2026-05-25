// BP34 §34.2 / §23.9 — Gmail OAuth helpers.
//
// Uses fetch + jose for verification; no @google-cloud/* SDK dep.
//
// Env vars required (configured per GCP runbook):
//   GMAIL_OAUTH_CLIENT_ID
//   GMAIL_OAUTH_CLIENT_SECRET
//   GMAIL_OAUTH_REDIRECT_URI   (e.g. https://platform.example.com/api/integrations/gmail/callback)
//   GMAIL_PUBSUB_TOPIC          (e.g. projects/<gcp-project>/topics/<topic>)

const GMAIL_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GMAIL_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const GMAIL_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// Scopes per §34.2 — read messages + modify (mark read after parsing).
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify"];

export function buildAuthorizationUrl(args: { state: string }): string {
  const clientId = requireEnv("GMAIL_OAUTH_CLIENT_ID");
  const redirectUri = requireEnv("GMAIL_OAUTH_REDIRECT_URI");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline", // requests refresh_token
    prompt: "consent", // forces refresh_token even on subsequent connects
    state: args.state,
  });
  return `${GMAIL_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

export type ExchangeResult = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: "Bearer";
};

export async function exchangeCodeForTokens(code: string): Promise<ExchangeResult> {
  const clientId = requireEnv("GMAIL_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GMAIL_OAUTH_CLIENT_SECRET");
  const redirectUri = requireEnv("GMAIL_OAUTH_REDIRECT_URI");
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const r = await fetch(GMAIL_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    throw new Error(`oauth_exchange_status_${r.status}:${(await r.text()).slice(0, 200)}`);
  }
  const j = (await r.json()) as Partial<ExchangeResult> & { error?: string };
  if (!j.access_token || !j.refresh_token) {
    throw new Error(`oauth_exchange_incomplete:${j.error ?? "missing_tokens"}`);
  }
  return j as ExchangeResult;
}

// gmail.users.watch — registers a push subscription to the Pub/Sub topic.
// Returns the historyId to anchor subsequent history.list calls.
export async function startGmailWatch(args: {
  access_token: string;
}): Promise<{ historyId: string; expiration: number }> {
  const topicName = requireEnv("GMAIL_PUBSUB_TOPIC");
  const r = await fetch(`${GMAIL_API_BASE}/users/me/watch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ topicName, labelIds: ["INBOX"] }),
  });
  if (!r.ok) {
    throw new Error(`gmail_watch_status_${r.status}:${(await r.text()).slice(0, 200)}`);
  }
  const j = (await r.json()) as { historyId?: string; expiration?: string };
  if (!j.historyId || !j.expiration) {
    throw new Error("gmail_watch_response_incomplete");
  }
  return { historyId: j.historyId, expiration: Number(j.expiration) };
}

export async function stopGmailWatch(args: { access_token: string }): Promise<void> {
  const r = await fetch(`${GMAIL_API_BASE}/users/me/stop`, {
    method: "POST",
    headers: { Authorization: `Bearer ${args.access_token}` },
  });
  if (!r.ok && r.status !== 204) {
    throw new Error(`gmail_stop_status_${r.status}:${(await r.text()).slice(0, 200)}`);
  }
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(`${GMAIL_OAUTH_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

// Fetch the connected user's email address — used to populate
// connected_email so the Pub/Sub webhook can route by it.
export async function getProfileEmail(access_token: string): Promise<string> {
  const r = await fetch(`${GMAIL_API_BASE}/users/me/profile`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!r.ok) throw new Error(`gmail_profile_status_${r.status}`);
  const j = (await r.json()) as { emailAddress?: string };
  if (!j.emailAddress) throw new Error("gmail_profile_no_email");
  return j.emailAddress;
}

export async function mintAccessTokenFromRefresh(refresh_token: string): Promise<string> {
  const clientId = requireEnv("GMAIL_OAUTH_CLIENT_ID");
  const clientSecret = requireEnv("GMAIL_OAUTH_CLIENT_SECRET");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const r = await fetch(GMAIL_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    throw new Error(`oauth_refresh_status_${r.status}:${(await r.text()).slice(0, 200)}`);
  }
  const j = (await r.json()) as { access_token?: string; error?: string };
  if (!j.access_token) throw new Error(`oauth_refresh_no_access_token:${j.error ?? "unknown"}`);
  return j.access_token;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`env_missing:${name}`);
  return v;
}
