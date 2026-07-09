// §6.12 — Retrieval log retention.
//
// Per spec: retrieval log detail kept 90 days, then aggregated. After 90
// days the per-call rows are deleted, but a daily aggregate is kept for
// long-term trend analysis.
//
// This cron runs nightly:
//   1. Inserts daily aggregates for rows older than 90 days that haven't
//      been aggregated yet.
//   2. Deletes detail rows older than 90 days.
//
// The aggregate row groups by (tenant_id, day, outcome) and counts +
// avg-latencies. Deliberately coarse — keeps long-term storage cheap.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { inngest } from "./client";

function ragDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_RAG_URL;
  const key = process.env.SUPABASE_RAG_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("RAG Supabase env not set for retrieval-log-aggregate");
  return createClient(url, key, { auth: { persistSession: false } });
}

const RETENTION_DAYS = 90;

export const retrievalLogAggregate = inngest.createFunction(
  {
    id: "retrieval-log-aggregate",
    triggers: [{ cron: "15 3 * * *" }], // daily 03:15 UTC, before main-app retention crons
  },
  async () => {
    if (process.env.STAGING_MODE === "true") return { skipped_for_staging: true };

    const db = ragDb();
    const cutoffIso = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();

    // Step 1 — produce daily aggregates for rows older than 90 days that
    // haven't been aggregated yet. The aggregate target table is
    // `rag_retrieval_log_daily`; the migration that introduces it is
    // 0017_retrieval_log_aggregate.sql (companion to this cron).
    const { data: aggData, error: aggErr } = await db.rpc("aggregate_retrieval_log_pre_cutoff", {
      p_cutoff: cutoffIso,
    });
    if (aggErr) {
      console.error("[retrieval-log-aggregate] aggregate rpc failed:", aggErr.message);
      return { ok: false, error: aggErr.message };
    }

    // Step 2 — delete detail rows older than 90 days. Per §6.12,
    // detail is retained 90 days and aggregated thereafter.
    const { count, error: delErr } = await db
      .from("rag_retrieval_log")
      .delete({ count: "exact" })
      .lt("created_at", cutoffIso);
    if (delErr) {
      console.error("[retrieval-log-aggregate] delete failed:", delErr.message);
      return { ok: false, aggregated: aggData, error: delErr.message };
    }

    return { ok: true, aggregated: aggData, deleted: count ?? 0, cutoff: cutoffIso };
  },
);
