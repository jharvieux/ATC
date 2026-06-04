// Issue #686 — Enqueue a chunk for batch embedding.
//
// Writes one pending_embedding row tied to a freshly-inserted (or freshly-
// content-updated) knowledge_chunks row. The flush cron will collect these
// and submit them as a single OpenAI batch.

import type { SupabaseClient } from "@supabase/supabase-js";
import { safeAwait } from "@/lib/db/safe-mutation";

export interface EnqueueEmbeddingArgs {
  chunk_id: string;
  content: string;
  /** Triggering tenant for cost attribution. NULL for platform-admin
   *  ingests (global itinerary/reference, approve/global, replace-chunk
   *  on global chunks). */
  tenant_id: string | null;
  db: SupabaseClient;
}

export interface EnqueueEmbeddingResult {
  pending_id: string;
  custom_id: string;
}

export async function enqueueEmbedding(
  args: EnqueueEmbeddingArgs,
): Promise<EnqueueEmbeddingResult> {
  const trimmed = args.content?.trim();
  if (!trimmed) {
    throw new Error("enqueueEmbedding: content is empty");
  }
  if (!args.chunk_id) {
    throw new Error("enqueueEmbedding: chunk_id is required");
  }

  // custom_id must be unique across all pending rows; OpenAI echoes it back
  // in the result file. We use crypto.randomUUID() rather than the row id
  // (which DEFAULT-generates) so we can set both fields atomically at insert.
  const customId = crypto.randomUUID();

  const row = await safeAwait(
    args.db
      .from("pending_embedding")
      .insert({
        chunk_id: args.chunk_id,
        content: trimmed,
        custom_id: customId,
        status: "pending",
        tenant_id: args.tenant_id,
      })
      .select("id, custom_id")
      .single(),
    "pending_embedding.insert",
  );

  const r = row as unknown as { id: string; custom_id: string };
  return { pending_id: r.id, custom_id: r.custom_id };
}
