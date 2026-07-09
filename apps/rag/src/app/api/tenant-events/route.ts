// §8.7 — Inbound tenant lifecycle events from the main app
//
// Does NOT use withServiceAuth (chicken-and-egg: this endpoint is how RAG
// learns about tenant existence in the first place). Instead, verifies the
// X-Webhook-Signature header using HMAC-SHA256 over the raw body with
// RAG_WEBHOOK_SECRET.
export const dynamic = "force-dynamic";

import { createClient } from "@supabase/supabase-js";
import { TenantEventSchema, verifyWebhookSignature, type TenantEvent } from "@atc/contracts";

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();

  const secret = process.env.RAG_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }
  const validSignature = await verifyWebhookSignature(
    secret,
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

  const db = createClient(
    process.env.SUPABASE_RAG_URL!,
    process.env.SUPABASE_RAG_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

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
