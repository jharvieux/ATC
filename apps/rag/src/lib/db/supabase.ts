import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | undefined;

export function getRagDb(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_RAG_URL;
    const key = process.env.SUPABASE_RAG_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_RAG_URL or SUPABASE_RAG_SERVICE_ROLE_KEY not set");
    _client = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${key}` } },
    });
  }
  return _client;
}
