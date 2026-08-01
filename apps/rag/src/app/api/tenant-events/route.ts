// §8.7 — Inbound tenant lifecycle events from the main app
//
// Does NOT use withServiceAuth (chicken-and-egg: this endpoint is how RAG
// learns about tenant existence in the first place). Instead, verifies the
// X-Webhook-Signature header using HMAC-SHA256 over the raw body with
// RAG_WEBHOOK_SECRET.
export const dynamic = "force-dynamic";

import { getRagDb } from "@/lib/db/supabase";
import { TenantEventSchema, type TenantEvent } from "@atc/contracts";
import { ragWebhookSecrets, verifyRagWebhookSignature } from "@/lib/webhook-secret";

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();

  // #2004 — _CURRENT/_PREVIOUS rotation set (D-091 #28); legacy var accepted.
  if (ragWebhookSecrets().length === 0) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }
  const validSignature = await verifyRagWebhookSignature(
    rawBody,
    req.headers.get("x-webhook-signature"),
  );
  if (!validSignature) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  // Parse body
  let parsed: TenantEvent;
  try {
    parsed = TenantEventSchema.parse(JSON.parse(rawBody));
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getRagDb();

  // Check existing row
  const { data: existing } = await db
    .from("tenant_registry_shadow")
    .select("source_revision")
    .eq("tenant_id", parsed.tenant_id)
    .maybeSingle();

  // Stale revision — ack without updating
  if (existing && existing.source_revision >= parsed.source_revision) {
    return Response.json({ ignored: "stale_revision" });
  }

  // Upsert
  const { error } = await db.from("tenant_registry_shadow").upsert({
    tenant_id: parsed.tenant_id,
    status: parsed.payload.status,
    tenant_type: parsed.payload.tenant_type,
    display_name: parsed.payload.display_name,
    source_revision: parsed.source_revision,
    last_webhook_sync_at: new Date().toISOString(),
  });

  if (error) {
    console.error("[tenant-events] upsert failed:", error.message);
    return Response.json({ error: "db_error" }, { status: 500 });
  }

  return Response.json({ ok: true });
}
