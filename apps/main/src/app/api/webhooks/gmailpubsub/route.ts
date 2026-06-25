// BP34 §34.2 — Gmail Pub/Sub push webhook.
//
// Pub/Sub pushes a JSON envelope here with a Google-signed bearer JWT in
// the Authorization header (audience = this URL). On every push:
//
//   1. Verify the bearer JWT against Google's JWKS.
//   2. Decode the envelope's base64 `message.data`, which is the JSON
//      blob Gmail emits per the gmail.users.watch contract:
//        { emailAddress, historyId }
//   3. Look up the tenant's row in gmail_oauth_tokens by emailAddress
//      and pull the historyId stored there as `pubsub_history_id`.
//   4. Fetch new message IDs via Gmail history.list (from stored
//      historyId to the new one).
//   5. For each new message: fetch the message, persist into
//      gmail_inbound_messages, and call processGmailInboundMessage()
//      which handles IMPORT-trigger detection + import.queued emission.
//   6. Update pubsub_history_id to the new value.
//
// All Google API calls are HTTP via fetch — no SDK dependency. The
// access token for Gmail REST is derived from the encrypted refresh
// token via the standard OAuth2 refresh endpoint.

import { jwtVerify, createRemoteJWKSet } from "jose";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { processGmailInboundMessage } from "@/lib/import/process-gmail-message";
import { decryptCredential } from "@/lib/crypto/credential-cipher";
import { safeAwait } from "@/lib/db/safe-mutation";
import { dbErrorResponse } from "@/lib/api/db-error-response";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISS = ["https://accounts.google.com", "accounts.google.com"];
const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

const jwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));

export async function POST(req: Request): Promise<Response> {
  // ── 1. Verify the bearer JWT ──────────────────────────────────────────
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (!token) return Response.json({ error: "missing_bearer" }, { status: 401 });

  const expectedAud = process.env.GMAIL_PUBSUB_AUDIENCE; // typically the webhook URL itself
  if (!expectedAud) {
    console.error("[gmailpubsub] GMAIL_PUBSUB_AUDIENCE not set");
    return Response.json({ error: "server_misconfig" }, { status: 500 });
  }
  try {
    await jwtVerify(token, jwks, { issuer: GOOGLE_ISS, audience: expectedAud });
  } catch (err) {
    console.warn("[gmailpubsub] jwt_verification_failed", err);
    return Response.json({ error: "jwt_verification_failed" }, { status: 401 });
  }

  // ── 2. Decode the Pub/Sub envelope ────────────────────────────────────
  const envelope = (await req.json().catch(() => null)) as { message?: { data?: string } } | null;
  const dataB64 = envelope?.message?.data;
  if (!dataB64) return Response.json({ error: "missing_message_data" }, { status: 400 });

  let payload: { emailAddress?: string; historyId?: string };
  try {
    payload = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));
  } catch {
    return Response.json({ error: "invalid_data_payload" }, { status: 400 });
  }
  if (!payload.emailAddress || !payload.historyId) {
    return Response.json({ error: "missing_payload_fields" }, { status: 400 });
  }

  // ── 3. Look up tenant by Gmail address ───────────────────────────────
  const svc = createServiceRoleClient();
  const { data: tokenRowData, error: tokenErr } = await svc
    .from("gmail_oauth_tokens")
    .select("tenant_id, encrypted_refresh_token, encryption_key_version, pubsub_history_id, health_status")
    .eq("connected_email", payload.emailAddress)
    .maybeSingle();
  if (tokenErr) return dbErrorResponse(tokenErr);
  if (!tokenRowData) {
    // Pub/Sub may push for an address we don't recognise (eg after a
    // disconnect raced with a queued push). Ack 200 so Pub/Sub doesn't
    // retry indefinitely.
    return Response.json({ skipped: "unknown_address" });
  }
  const tokenRow = tokenRowData as {
    tenant_id: string;
    encrypted_refresh_token: string | null;
    encryption_key_version: string | null;
    pubsub_history_id: string | null;
    health_status: string;
  };

  if (tokenRow.health_status !== "connected") {
    return Response.json({ skipped: "not_connected", health_status: tokenRow.health_status });
  }
  if (!tokenRow.encrypted_refresh_token) {
    return Response.json({ skipped: "no_refresh_token" });
  }

  // ── 4. Exchange refresh token for access token, list history ─────────
  const refreshResult = decryptCredential({
    ciphertext: tokenRow.encrypted_refresh_token,
    key_id: tokenRow.encryption_key_version ?? "",
  });
  if (!refreshResult.ok) {
    await markHealth(svc, tokenRow.tenant_id, "token_expired", `decrypt_failed:${refreshResult.error.code}`);
    return Response.json({ error: "refresh_token_decrypt_failed" }, { status: 500 });
  }
  const accessToken = await mintAccessToken(refreshResult.value).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    return { mintError: msg };
  });
  if (typeof accessToken !== "string") {
    await markHealth(svc, tokenRow.tenant_id, "token_expired", `oauth_refresh_failed:${accessToken.mintError}`);
    return Response.json({ error: "oauth_refresh_failed" }, { status: 502 });
  }

  const startHistoryId = tokenRow.pubsub_history_id ?? payload.historyId;
  const historyJson = await fetchGmailHistory(accessToken, startHistoryId);
  if (!historyJson.ok) {
    return Response.json({ error: "history_fetch_failed", detail: historyJson.error }, { status: 502 });
  }

  // history list returns added messages. Extract IDs.
  const newMessageIds: string[] = [];
  for (const h of historyJson.value.history ?? []) {
    for (const m of h.messagesAdded ?? []) {
      if (m.message?.id) newMessageIds.push(m.message.id);
    }
  }

  // ── 5. For each new message: fetch + persist + trigger-detect ────────
  const results: Array<{ message_id: string; qualified: boolean; reason?: string }> = [];
  for (const messageId of newMessageIds) {
    const msg = await fetchGmailMessage(accessToken, messageId);
    if (!msg.ok) {
      results.push({ message_id: messageId, qualified: false, reason: `fetch_failed:${msg.error}` });
      continue;
    }
    const { subject, from_email, to_email, body_text, body_html, threadId, internalDate } = extractMessageFields(msg.value);

    await safeAwait(svc
      .from("gmail_inbound_messages")
      .upsert({
        message_id: messageId,
        tenant_id: tokenRow.tenant_id,
        thread_id: threadId,
        from_email,
        to_email,
        subject,
        body_text,
        body_html,
        received_at: new Date(internalDate).toISOString(),
        raw_payload: msg.value,
        qualifies_for_import: false, // updated by processGmailInboundMessage if it triggers
      }), "gmail_inbound_messages.upsert");

    const procResult = await processGmailInboundMessage({
      tenant_id: tokenRow.tenant_id,
      message_id: messageId,
      subject: subject ?? "",
      body_text: body_text ?? "",
      svc,
    });
    if (procResult.qualified) {
      results.push({ message_id: messageId, qualified: true });
    } else {
      results.push({ message_id: messageId, qualified: false, reason: procResult.reason });
    }
  }

  // ── 6. Update the stored history pointer ─────────────────────────────
  await safeAwait(svc
    .from("gmail_oauth_tokens")
    .update({
      pubsub_history_id: payload.historyId,
      last_healthy_at: new Date().toISOString(),
      last_health_check_at: new Date().toISOString(),
    })
    .eq("tenant_id", tokenRow.tenant_id), "gmail_oauth_tokens.update");

  return Response.json({ processed: results.length, results });
}

// ── helpers ──────────────────────────────────────────────────────────────

async function mintAccessToken(refresh_token: string): Promise<string> {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GMAIL_OAUTH_CLIENT_ID/SECRET not set");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const r = await fetch(OAUTH_TOKEN_URL, {
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

async function fetchGmailHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<{ ok: true; value: GmailHistoryResponse } | { ok: false; error: string }> {
  const url = `${GMAIL_API_BASE}/users/me/history?startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return { ok: false, error: `history_status_${r.status}` };
  return { ok: true, value: (await r.json()) as GmailHistoryResponse };
}

async function fetchGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<{ ok: true; value: GmailMessage } | { ok: false; error: string }> {
  const url = `${GMAIL_API_BASE}/users/me/messages/${encodeURIComponent(messageId)}?format=full`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return { ok: false, error: `message_status_${r.status}` };
  return { ok: true, value: (await r.json()) as GmailMessage };
}

type GmailHistoryResponse = {
  history?: Array<{ messagesAdded?: Array<{ message?: { id?: string } }> }>;
};

type GmailMessage = {
  id: string;
  threadId?: string;
  internalDate?: string;
  payload?: GmailPayload;
};

type GmailPayload = {
  headers?: Array<{ name: string; value: string }>;
  parts?: GmailPayload[];
  body?: { data?: string };
  mimeType?: string;
};

function extractMessageFields(m: GmailMessage): {
  subject: string | null;
  from_email: string | null;
  to_email: string | null;
  body_text: string | null;
  body_html: string | null;
  threadId: string | null;
  internalDate: number;
} {
  const hdrs = m.payload?.headers ?? [];
  const header = (name: string) =>
    hdrs.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

  const subject = header("Subject");
  const from_email = header("From");
  const to_email = header("To");

  let body_text: string | null = null;
  let body_html: string | null = null;
  walkParts(m.payload, (p) => {
    if (!p.body?.data) return;
    if (p.mimeType === "text/plain" && body_text === null) {
      body_text = decodeBase64Url(p.body.data);
    } else if (p.mimeType === "text/html" && body_html === null) {
      body_html = decodeBase64Url(p.body.data);
    }
  });

  return {
    subject,
    from_email,
    to_email,
    body_text,
    body_html,
    threadId: m.threadId ?? null,
    internalDate: Number(m.internalDate ?? Date.now()),
  };
}

function walkParts(p: GmailPayload | undefined, fn: (p: GmailPayload) => void): void {
  if (!p) return;
  fn(p);
  for (const child of p.parts ?? []) walkParts(child, fn);
}

function decodeBase64Url(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

async function markHealth(
  svc: ReturnType<typeof createServiceRoleClient>,
  tenant_id: string,
  status: "token_expired" | "revoked" | "disconnected",
  error: string,
): Promise<void> {
  await safeAwait(svc
    .from("gmail_oauth_tokens")
    .update({
      health_status: status,
      last_health_check_at: new Date().toISOString(),
      last_health_error: error,
    })
    .eq("tenant_id", tenant_id), "gmail_oauth_tokens.update");
}
