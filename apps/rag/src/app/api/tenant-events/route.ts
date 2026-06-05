// §8.7 — Inbound tenant lifecycle events from the main app
//
// Does NOT use withServiceAuth (chicken-and-egg: this endpoint is how RAG
// learns about tenant existence in the first place). Instead, verifies the
// X-Webhook-Signature header using HMAC-SHA256 over the raw body with
// RAG_WEBHOOK_SECRET.
export const dynamic = "force-dynamic";

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const bodySchema = z.object({
  event_type: z.enum([
    "tenant.created",
    "tenant.status_changed",
    "tenant.terminated",
    "tenant.metadata_updated",
  ]),
  tenant_id: z.string().uuid(),
  source_revision: z.number().int().nonnegative(),
  payload: z.object({
    status: z.string(),
    tenant_type: z.string(),
    display_name: z.string(),
  }),
});

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();

  // Verify signature
  const sigHeader = req.headers.get("x-webhook-signature");
  const secret = process.env.RAG_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }
  const expected = await hmacHex(secret, rawBody);
  if (
    !sigHeader ||
    sigHeader.length !== expected.length ||
    !timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected))
  ) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  // Parse body
  let parsed: z.infer<typeof bodySchema>;
  try {
    parsed = bodySchema.parse(JSON.parse(rawBody));
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
