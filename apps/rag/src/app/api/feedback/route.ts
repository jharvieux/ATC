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
//
// F-rag-wh-02 (#1385): replay protection via a Redis dedup key keyed on a
// SHA-256 fingerprint of (message_id + signal_direction + sorted chunk_ids).
// A captured signed request re-delivers the same fingerprint → SET NX fails
// → 409 Conflict. TTL = 24h (far beyond any legitimate retry window).

export const dynamic = "force-dynamic";

import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { checkFeedbackRateLimit } from "@/lib/rate-limit/feedback-limit";
import { getRedis } from "@/lib/redis/client";

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

  // F-rag-wh-01: verify the HMAC signature BEFORE anything attacker-influenced.
  // Previously the rate limit ran first and bucketed on the spoofable
  // x-forwarded-for, so an unauthenticated caller could (a) force a pre-auth
  // Redis write on every request and (b) spoof the main app's egress IP to
  // share + exhaust the legitimate caller's bucket — 429'ing real feedback
  // before its signature was ever checked.
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

  // F-rag-wh-02 (#1385): build the dedup fingerprint here so the dedup check
  // can run AFTER the insert succeeds (D-091 Pattern 10: idempotency rows must
  // mean "fully processed," not "received"). The key is written only once the
  // DB write is confirmed, so a failed insert leaves no fingerprint — the main
  // app's retry can proceed cleanly.
  const fingerprint = createHash("sha256")
    .update(`${parsed.message_id ?? ""}:${parsed.signal_direction}:${[...parsed.chunk_ids].sort().join(",")}`)
    .digest("hex");
  const dedupKey = `feedback:dedup:${fingerprint}`;

  // §6.10 / D-087 rate limit, applied only to AUTHENTICATED requests now.
  // Bucket on the verified message_id (from the signed body) — never the
  // spoofable x-forwarded-for. Defense-in-depth: bounds blast radius of a
  // leaked secret.
  // null message_id: all no-id events share one "msg:global" bucket — acceptable
  // at the 120 rpm default; the main app sends a message_id for normal feedback.
  const rl = await checkFeedbackRateLimit(`msg:${parsed.message_id ?? "global"}`);
  if (!rl.allowed) {
    return Response.json(
      { error: "rate_limited", reset_seconds: rl.reset_seconds },
      { status: 429, headers: { "Retry-After": String(rl.reset_seconds) } },
    );
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

  // Write the dedup key only after the insert confirms success (D-091 Pattern 10).
  // If Redis is unavailable: fail-open in non-production, fail-closed in production.
  // Reverse risk (insert ok, Redis write fails): a replay would insert a duplicate row —
  // far less harmful than stranding a legitimate event behind a 409 for 24h.
  try {
    const redis = getRedis();
    const prevInserted = await redis.set(dedupKey, "1", "EX", 86_400, "NX");
    if (prevInserted === null) {
      return Response.json({ error: "duplicate_delivery" }, { status: 409 });
    }
  } catch (err) {
    if (process.env.NODE_ENV === "production") throw err;
    console.warn("[feedback] Redis unavailable for dedup — fail-open (non-production)");
  }

  return Response.json({
    ok: true,
    inserted_count: data?.length ?? 0,
    chunk_count: parsed.chunk_ids.length,
  });
}
