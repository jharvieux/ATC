// §22.4 Stage 3 — AI normalization + auto-flag for global.
//
// Triggered by 'rag.submission_ready_for_normalization'.
// Calls Haiku with the redacted content; persists the structured metadata
// on rag_submissions.normalization_result. Auto-flags for global review if
// global_relevance_score crosses the threshold.
//
// On failure: simple retry-with-backoff via Inngest's built-in retries
// (configured below). After exhaustion the row is marked normalization_status='failed'
// AND review_status='ready_for_review' so the tenant admin can decide
// without AI metadata per §22.13.
//
// content_hash is computed here so the dedup query on the tenant review queue
// has a stable hash regardless of redaction outcome (hashes the redacted
// content, which is what becomes the chunk).

import { createHash } from "node:crypto";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { haikuNormalize } from "@/lib/rag-ingest/haiku-normalize";

export const ragNormalize = inngest.createFunction(
  {
    id: "rag-normalize",
    retries: 3,
    triggers: [{ event: "rag.submission_ready_for_normalization" }],
  },
  async ({ event, attempt }) => {
    const submission_id = event.data.submission_id as string;
    const tenant_id = event.data.tenant_id as string;
    const db = createServiceRoleClient();

    const { data: sub } = await db
      .from("rag_submissions")
      .select("redacted_content, extracted_content")
      .eq("id", submission_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();

    const row = sub as { redacted_content: string | null; extracted_content: string | null } | null;
    const content = row?.redacted_content ?? row?.extracted_content ?? "";
    if (content.length === 0) {
      await db
        .from("rag_submissions")
        .update({
          normalization_status: "failed",
          review_status: "ready_for_review",
          updated_at: new Date().toISOString(),
        })
        .eq("id", submission_id);
      return { ok: false, reason: "no_content" };
    }

    const content_hash = createHash("sha256").update(content).digest("hex");

    const norm = await haikuNormalize(content);
    if (norm.status === "failed") {
      const isLastAttempt = attempt >= 3;
      if (!isLastAttempt) {
        // Re-throw so Inngest schedules the retry per the function config.
        throw new Error(`normalization_failed: ${norm.error}`);
      }
      // Exhausted: still surface for manual review, just without AI metadata.
      await db
        .from("rag_submissions")
        .update({
          normalization_status: "failed",
          review_status: "ready_for_review",
          content_hash,
          updated_at: new Date().toISOString(),
        })
        .eq("id", submission_id);
      return { ok: false, reason: "normalization_exhausted", attempts: attempt };
    }

    const threshold = Number(process.env.RAG_INGEST_GLOBAL_RELEVANCE_AUTOFLAG_THRESHOLD ?? 0.6);
    const autoFlag = norm.result.global_relevance_score >= threshold;

    await db
      .from("rag_submissions")
      .update({
        normalization_status: "normalized",
        normalization_result: norm.result,
        auto_flagged_for_global: autoFlag,
        content_hash,
        review_status: "ready_for_review",
        updated_at: new Date().toISOString(),
      })
      .eq("id", submission_id);

    return { ok: true, auto_flagged: autoFlag };
  },
);
