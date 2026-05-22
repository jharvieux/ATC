// §17.2 — Microsoft OAuth no-email recovery chain.
//
// Steps:
//   1. oauth.email from the OAuth claims
//   2. Graph /me?$select=mail
//   3. Graph /me?$select=otherMails
//   4. Return null → caller renders /signup/email-prompt

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export async function recoverMicrosoftEmail(
  oauthEmail: string | null | undefined,
  accessToken: string,
): Promise<string | null> {
  // Step 1: OAuth claim
  if (oauthEmail && isValidEmail(oauthEmail)) return oauthEmail;

  // Step 2: Graph /me mail field
  const meRes = await graphFetch(`${GRAPH_BASE}/me?$select=mail`, accessToken);
  const mail = typeof meRes.mail === "string" ? meRes.mail : null;
  if (mail && isValidEmail(mail)) return mail;

  // Step 3: Graph /me otherMails
  const otherRes = await graphFetch(`${GRAPH_BASE}/me?$select=otherMails`, accessToken);
  const otherMails = Array.isArray(otherRes.otherMails) ? (otherRes.otherMails as string[]) : [];
  const first = otherMails[0];
  if (first && isValidEmail(first)) return first;

  // Step 4: all sources exhausted
  return null;
}

async function graphFetch(url: string, token: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return {};
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
