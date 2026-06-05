// D-041 follow-up — Receive platform_settings updates from the main app.
//
// Mirrors apps/rag/src/app/api/tenant-events/route.ts (§8.7). Same HMAC
// signature pattern, same stale-revision guard, same single-purpose role:
// keep the rag-side platform_settings replica current so plpgsql functions
// (compute_feedback_factor, match_knowledge_chunks) read fresh weights.
//
// Does NOT use withServiceAuth — this endpoint is the source of truth for
// platform-config propagation; verifying via HMAC over the raw body with
// RAG_WEBHOOK_SECRET keeps it independent of the per-tenant JWT path.
export const dynamic = "force-dynamic";

import { timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const bodySchema = z.object({
  event_type: z.literal("platform_settings.updated"),
  source_revision: z.number().int().nonnegative(),
  payload: z.object({
    changes: z
      .array(
        z.object({
          key: z.string().min(1).max(128),
          // value is JSONB — accept anything serialisable.
          value: z.unknown(),
        }),
      )
      .min(1),
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

  const sigHeader = req.headers.get("x-webhook-signature");
  const secret = process.env.RAG_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: "server_misconfigured" }, { status: 500 });
  }
  const expected = await hmacHex(secret, rawBody);
  // Both sides are lowercase hex strings from hmacHex(); Buffer.from(str)
  // defaults to UTF-8, comparing character bytes — correct for hex comparison.
  // Length parity check prevents the Buffer.byteLength mismatch throw.
  if (
    !sigHeader ||
    sigHeader.length !== expected.length ||
    !timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected))
  ) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

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

  // Apply each change independently. A stale source_revision on a key skips
  // THAT key only — other keys in the same event still apply if fresher.
  // This is important when two near-simultaneous admin actions arrive out
  // of order: each key has its own monotonic timeline.
  const applied: string[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];

  for (const change of parsed.payload.changes) {
    const { data: existing } = await db
      .from("platform_settings")
      .select("source_revision")
      .eq("key", change.key)
      .maybeSingle();

    if (existing && (existing as { source_revision: number }).source_revision >= parsed.source_revision) {
      skipped.push({ key: change.key, reason: "stale_revision" });
      continue;
    }

    const { error } = await db
      .from("platform_settings")
      .upsert({
        key: change.key,
        value: change.value as Record<string, unknown> | string | number | boolean | null,
        source_revision: parsed.source_revision,
        last_webhook_sync_at: new Date().toISOString(),
      });

    if (error) {
      console.error("[platform-settings-events] upsert failed:", { key: change.key, error: error.message });
      skipped.push({ key: change.key, reason: `db_error: ${error.message}` });
      continue;
    }
    applied.push(change.key);
  }

  return Response.json({ applied, skipped });
}
