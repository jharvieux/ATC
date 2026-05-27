// audit-2026-05-26: Greptile review checkpoint (will be reverted; do not merge)
// §6.10 — Inbound chunk feedback events from the main app.
//
// When a customer thumbs-up or thumbs-down an AI response on the main
// app, the main app calls here with the chunk_ids that the response
// cited. We insert one row per chunk into knowledge_chunk_feedback_events
// and bump the rolling counters on knowledge_chunks.
//
// HMAC-SHA256 over the raw body with RAG_WEBHOOK_SECRET — same scheme
// as /api/tenant-events. Does NOT use withServiceAuth (no per-tenant
// JWT for this cross-cutting concern; the HMAC is the auth surface).

export const dynamic = "force-dynamic";

import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { checkFeedbackRateLimit } from "@/lib/rate-limit/feedback-limit";

const bodySchema = z.object({
  message_id: z.string().uuid().nullable(),
  signal_direction: z.enum(["up", "down"]),
  raw_weight: z.number().min(0).max(10),
  chunk_ids: z.array(z.string().uuid()).min(1).max(20),
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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) {
    r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return r === 0;
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.RAG_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: "rag_webhook_secret_not_configured" }, { status: 500 });
  }

  // §6.10 / D-087 rate limit. Defense-in-depth: HMAC verifies the caller
  // shares the secret; rate limit bounds blast radius if the secret leaks.
  // Short prefix of the secret (8 chars) is the bucket hint so legitimate
  // rotations don't bleed buckets across keys.
  const secretHint = secret.slice(0, 8);
  const rl = await checkFeedbackRateLimit(req, secretHint);
  if (!rl.allowed) {
    return Response.json(
      { error: "rate_limited", reset_seconds: rl.reset_seconds },
      { status: 429, headers: { "Retry-After": String(rl.reset_seconds) } },
    );
  }

  const rawBody = await req.text();
  const provided = req.headers.get("x-webhook-signature") ?? "";
  const expected = await hmacHex(secret, rawBody);
  if (!timingSafeEqual(provided, expected)) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  let parsed;
  try {
    parsed = bodySchema.parse(JSON.parse(rawBody));
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_RAG_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_RAG_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return Response.json({ error: "supabase_env_not_set" }, { status: 500 });
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // Insert one row per chunk. Best-effort: a failure on one row doesn't
  // stop the rest. The §6.10 compute_feedback_factor() reads the events
  // at retrieval time, so even partial writes still influence ranking.
  const inserts = parsed.chunk_ids.map((chunkId) => ({
    chunk_id: chunkId,
    message_id: parsed.message_id,
    signal_direction: parsed.signal_direction,
    raw_weight: parsed.raw_weight,
  }));

  const { data, error } = await db
    .from("knowledge_chunk_feedback_events")
    .insert(inserts)
    .select("id");

  if (error) {
    console.error("[feedback] insert error:", error.message);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({
    ok: true,
    inserted_count: data?.length ?? 0,
    chunk_count: parsed.chunk_ids.length,
  });
}
