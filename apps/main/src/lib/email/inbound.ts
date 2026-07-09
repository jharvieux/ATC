// #890 Phase 1 — inbound persona-address email (docs/design/inbound-persona-email.md).
//
// Resend's `email.received` webhook payload is metadata-only (email_id, from,
// to, subject, attachment list) — the body and the In-Reply-To/References
// headers needed for tenant resolution require a separate Receiving API fetch.
// That fetch is best-effort: if it fails, we still resolve via unique-sender
// fallback and persist the metadata, so no reply is silently dropped.
//
// Tenant resolution (in precedence order):
//   1. "references" — an In-Reply-To/References header token matches an
//      email_log.resend_message_id we sent. Deterministic and spoof-resistant:
//      an attacker can't know another tenant's provider message ids.
//   2. "sender"     — the from-address matches exactly ONE contacts row across
//      all tenants. Zero or multiple matches → unresolved (a forged sender must
//      never attach mail to another tenant, so ambiguity fails closed).
//   3. "unresolved" — persisted with tenant_id NULL; surfaced on the
//      platform-admin list instead of being dropped.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// NOTE(#890): REST path inferred from the SDK's `emails.receiving.get()` —
// confirm against the Resend dashboard/docs at integration time (same session
// the MX record + webhook are provisioned). A wrong path degrades gracefully:
// fetchReceivedEmail returns null and processing continues metadata-only.
const RESEND_RECEIVING_URL = "https://api.resend.com/emails/receiving";

export interface ReceivedEmailContent {
  text: string | null;
  headers: unknown;
}

export async function fetchReceivedEmail(emailId: string): Promise<ReceivedEmailContent | null> {
  const apiKey = process.env.RESEND_API_KEY;
  // email_id arrives from a signature-verified webhook, but pin the shape
  // anyway so a hostile value can never traverse the URL path.
  if (!apiKey || !/^[A-Za-z0-9_-]+$/.test(emailId)) return null;
  try {
    const res = await fetch(`${RESEND_RECEIVING_URL}/${emailId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { text?: string | null; headers?: unknown };
    return { text: body.text ?? null, headers: body.headers ?? null };
  } catch {
    return null;
  }
}

/**
 * Extract candidate Resend message-id tokens from In-Reply-To/References.
 * Tolerates both header shapes (record or array of {name,value}) since the
 * Receiving API response format isn't pinned by a fixture yet. RFC 5322
 * message-ids look like <local@domain>; email_log stores the bare Resend API
 * id, so both the full token and its local part are returned as candidates.
 */
export function extractReferencedMessageIds(headers: unknown): string[] {
  const wanted = new Set(["in-reply-to", "references"]);
  const values: string[] = [];

  if (Array.isArray(headers)) {
    for (const h of headers) {
      const name = (h as { name?: unknown }).name;
      const value = (h as { value?: unknown }).value;
      if (typeof name === "string" && typeof value === "string" && wanted.has(name.toLowerCase())) {
        values.push(value);
      }
    }
  } else if (headers && typeof headers === "object") {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (wanted.has(name.toLowerCase()) && typeof value === "string") values.push(value);
    }
  }

  const ids = new Set<string>();
  for (const value of values) {
    for (const match of value.matchAll(/<([^<>\s]+)>/g)) {
      const token = match[1] as string;
      ids.add(token);
      const at = token.indexOf("@");
      if (at > 0) ids.add(token.slice(0, at));
    }
  }
  return [...ids];
}

export type InboundResolution =
  | { method: "references" | "sender"; tenant_id: string; contact_id: string | null }
  | { method: "unresolved" };

export async function resolveInboundTenant(args: {
  db: SupabaseClient;
  referencedIds: string[];
  fromEmail: string;
}): Promise<InboundResolution> {
  const { db, referencedIds, fromEmail } = args;

  if (referencedIds.length > 0) {
    const { data } = await db
      .from("email_log")
      .select("tenant_id, contact_id")
      .in("resend_message_id", referencedIds)
      .limit(1);
    const row = (data as { tenant_id: string; contact_id: string | null }[] | null)?.[0];
    if (row) return { method: "references", tenant_id: row.tenant_id, contact_id: row.contact_id ?? null };
  }

  // limit(2) is all the ambiguity check needs — 2+ rows means non-unique.
  const { data: contacts } = await db
    // Deliberately cross-tenant: the tenant is what this lookup DETERMINES.
    // Read-only, and ambiguity (2+ tenants) fails closed to unresolved so a
    // forged sender can't steer another tenant's mail.
    // d091-allow:service-role-tenant tenant unknown until this resolves it
    .from("contacts")
    .select("id, tenant_id")
    .eq("email", fromEmail)
    .limit(2);
  const rows = (contacts as { id: string; tenant_id: string }[] | null) ?? [];
  if (rows.length === 1) {
    const only = rows[0] as { id: string; tenant_id: string };
    return { method: "sender", tenant_id: only.tenant_id, contact_id: only.id };
  }
  return { method: "unresolved" };
}
