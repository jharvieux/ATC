// Shared forum/thread resolution for the anonymous-invitee (HMAC-token)
// forum routes under app/api/groups/invite/[token]/forum/**. Token validity
// (checks 1-4) is handled separately by invitation-token-checks.ts; these
// helpers just resolve the forum/thread rows once a validated group is in
// hand, with the explicit tenant_id filter required for forums/forum_threads/
// forum_messages (they carry a real tenant_id column, unlike the invitations/
// groups lookups in invitation-token-checks.ts).

import type { SupabaseClient } from "@supabase/supabase-js";

export interface GuestForum {
  id: string;
  is_locked: boolean;
}

export interface GuestThread {
  id: string;
  is_locked: boolean;
}

export async function resolveGuestForum(
  svc: SupabaseClient,
  groupId: string,
  tenantId: string,
): Promise<{ data: GuestForum | null; error: unknown }> {
  const { data, error } = await svc
    .from("forums")
    .select("id, is_locked")
    .eq("group_id", groupId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return { data: data as GuestForum | null, error };
}

export async function resolveGuestThread(
  svc: SupabaseClient,
  forumId: string,
  threadId: string,
  tenantId: string,
): Promise<{ data: GuestThread | null; error: unknown }> {
  const { data, error } = await svc
    .from("forum_threads")
    .select("id, is_locked")
    .eq("id", threadId)
    .eq("forum_id", forumId)
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .maybeSingle();
  return { data: data as GuestThread | null, error };
}
