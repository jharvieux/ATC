// Shared chunked status-flip for pending_embedding rows (#805).
//
// A single PostgREST `.in("id", [...])` with up to MAX_REQUESTS_PER_BATCH (2,000)
// UUIDs builds a ~80 KB query string that exceeds the URL-length limit, so the
// UPDATE fails. In the flush that failure lands AFTER the OpenAI batch is created
// — an un-chunked flip 500-loops and re-bills batches without draining the queue
// (the #789 regression). Both flush and reconcile flip up to 2,000 rows at once,
// so they share this helper rather than duplicating the chunking loop.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";

export const STATUS_FLIP_CHUNK = 200;

export async function bulkFlipPendingStatus(
  db: SupabaseClient,
  ids: string[],
  payload: Record<string, unknown>,
  context: string,
): Promise<void> {
  for (let i = 0; i < ids.length; i += STATUS_FLIP_CHUNK) {
    await safeAwait(
      // d091-allow:service-role-tenant — platform embedding cron; pending_embedding.tenant_id nullable by design; cross-tenant status flip required.
      db.from("pending_embedding").update(payload).in("id", ids.slice(i, i + STATUS_FLIP_CHUNK)),
      context,
    );
  }
}
