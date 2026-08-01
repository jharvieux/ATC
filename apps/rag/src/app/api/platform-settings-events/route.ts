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

import { getRagDb } from "@/lib/db/supabase";
import { PlatformEventSchema, type PlatformEvent } from "@atc/contracts";
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

  let parsed: PlatformEvent;
  try {
    parsed = PlatformEventSchema.parse(JSON.parse(rawBody));
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const db = getRagDb();

  // Apply each change independently. A stale source_revision on a key skips
  // THAT key only — other keys in the same event still apply if fresher.
  // This is important when two near-simultaneous admin actions arrive out
  // of order: each key has its own monotonic timeline.
  const applied: string[] = [];
  const skipped: Array<{ key: string; reason: string }> = [];

  // #1787 — one batched read for all keys in the event instead of a
  // select-per-key loop.
  const keys = parsed.payload.changes.map((c) => c.key);
  const { data: existingRows } = await db
    .from("platform_settings")
    .select("key, source_revision")
    .in("key", keys);
  const existingByKey = new Map(
    ((existingRows ?? []) as Array<{ key: string; source_revision: number }>).map((r) => [r.key, r.source_revision]),
  );

  const freshChanges = parsed.payload.changes.filter((change) => {
    const existingRevision = existingByKey.get(change.key);
    if (existingRevision !== undefined && existingRevision >= parsed.source_revision) {
      skipped.push({ key: change.key, reason: "stale_revision" });
      return false;
    }
    return true;
  });

  // Upserts stay per-key (not batched into one call) so a DB error on one
  // key doesn't fail keys that would otherwise have applied — same
  // per-key error isolation as the prior sequential loop, just concurrent.
  await Promise.all(
    freshChanges.map(async (change) => {
      const { error } = await db
        .from("platform_settings")
        .upsert({
          key: change.key,
          value: change.value as Record<string, unknown> | string | number | boolean | null,
          source_revision: parsed.source_revision,
          last_webhook_sync_at: new Date().toISOString(),
        });

      if (error) {
        console.error("[platform-settings-events] upsert failed:", { key: change.key }, error);
        skipped.push({ key: change.key, reason: "db_error" });
        return;
      }
      applied.push(change.key);
    }),
  );

  return Response.json({ applied, skipped });
}
