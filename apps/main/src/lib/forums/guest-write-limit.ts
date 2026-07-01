// Rate limit for anonymous (invite-token) forum writes — thread creation and
// message posting both call this. Fail-closed: an RPC error propagates
// (thrown) rather than allowing the write, same as lib/chat/anonymous-limit.ts.

import type { SupabaseClient } from "@supabase/supabase-js";

const WINDOW_SECONDS = 60 * 60;

export async function enforceGuestForumWriteLimit(
  svc: SupabaseClient,
  invitation_id: string,
  tenant_id: string,
): Promise<boolean> {
  const cap = Number(process.env.FORUM_GUEST_WRITE_LIMIT_PER_HOUR ?? 20);
  const { data, error } = await svc.rpc("increment_forum_guest_write_counter", {
    p_invitation_id: invitation_id,
    p_tenant_id: tenant_id,
    p_window_seconds: WINDOW_SECONDS,
  });
  if (error) throw new Error(`increment_forum_guest_write_counter failed: ${error.message}`);
  const count = Number(data);
  if (!Number.isFinite(count)) {
    throw new Error("increment_forum_guest_write_counter returned a non-numeric count");
  }
  return count <= cap;
}
