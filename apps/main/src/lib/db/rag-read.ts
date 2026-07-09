// Issue #689 — Read-only Supabase client for the RAG project, used by the
// platform admin Resource Utilization dashboard to read rag_ai_call_log.
//
// Separate from any tenant-data path. The dashboard route is the only
// caller; if you find yourself adding more, take that as a signal to
// reconsider the architecture (cross-project reads from main → rag should
// stay narrow).

import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | undefined;

export function getRagReadClient(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_RAG_URL;
    const key = process.env.SUPABASE_RAG_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        "SUPABASE_RAG_URL or SUPABASE_RAG_SERVICE_ROLE_KEY not set " +
          "(needed by the platform admin dashboard to read rag_ai_call_log).",
      );
    }
    _client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${key}` } },
    });
  }
  return _client;
}
