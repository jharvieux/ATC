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
import { assertTenantStillPayingById } from "@/lib/billing/exclude-non-paying";

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

    // §15.16 — Skip past-grace tenants. Normalisation is a Haiku call;
    // no AI spend on tenants that have lost service.
    const paymentCheck = await assertTenantStillPayingById(db, tenant_id);
    if (!paymentCheck.ok) {
      console.info("[rag-normalize] skipping past-grace tenant", { tenant_id, submission_id, reason: paymentCheck.reason });
      return { skipped: true, reason: paymentCheck.reason };
    }

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

    const norm = await haikuNormalize(content, { tenant_id });
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

    // §27.4.2 auto-delete check — only for LOW-relevance submissions that
    // would land as tenant-scoped chunks. Queue-eligible (auto-flagged)
    // items don't count against the cap while pending review.
    if (!autoFlag) {
      const { resolveThresholds } = await import("@/lib/abuse/thresholds");
      const { data: quotaRow } = await db
        .from("tenant_rag_quotas")
        .select("current_tenant_chunks_count, promoted_chunks_count")
        .eq("tenant_id", tenant_id)
        .maybeSingle();
      const currentCount = Number((quotaRow as { current_tenant_chunks_count?: number } | null)?.current_tenant_chunks_count ?? 0);
      const promoted = Number((quotaRow as { promoted_chunks_count?: number } | null)?.promoted_chunks_count ?? 0);

      // Resolve tenant tier for thresholds.
      const { data: tenantRow } = await db
        .from("tenants")
        .select("id, tier_id, seat_count, billing_period")
        .eq("id", tenant_id)
        .maybeSingle();
      const tr = tenantRow as { tier_id?: string; seat_count?: number; billing_period?: "monthly" | "annual" } | null;
      let tier_code: "byo_research" | "byo_professional" | "byo_agency" | "sub_starter" | "sub_pro" | "sub_agency" = "byo_research";
      if (tr?.tier_id) {
        const { data: td } = await db.from("tier_definitions").select("code").eq("id", tr.tier_id).maybeSingle();
        const code = (td as { code?: string } | null)?.code;
        if (code && ["byo_research","byo_professional","byo_agency","sub_starter","sub_pro","sub_agency"].includes(code)) {
          tier_code = code as typeof tier_code;
        }
      }

      const thresholds = await resolveThresholds(db, {
        tenant_id,
        tier_code,
        seat_count: tr?.seat_count ?? 1,
        billing_period: tr?.billing_period ?? "monthly",
      }, promoted);

      if (currentCount >= thresholds.rag_cap_total.effective) {
        // Auto-delete the submission per §27.4.2.
        await db
          .from("rag_submissions")
          .update({
            normalization_status: "normalized",
            normalization_result: norm.result,
            auto_flagged_for_global: false,
            content_hash,
            review_status: "auto_deleted",
            updated_at: new Date().toISOString(),
          })
          .eq("id", submission_id);

        await db.from("tenant_rag_cap_events").insert({
          tenant_id,
          event_type: "submission_auto_deleted",
          queue_id: submission_id,
          cap_before: thresholds.rag_cap_total.effective,
          cap_after: thresholds.rag_cap_total.effective,
          count_before: currentCount,
          count_after: currentCount,
          reason: `over_cap (score=${norm.result.global_relevance_score.toFixed(2)}, current=${currentCount}, cap=${thresholds.rag_cap_total.effective})`,
        });

        return { ok: true, auto_deleted: true, reason: "over_cap_low_relevance" };
      }
    }

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
