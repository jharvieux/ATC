import type { User } from "@supabase/supabase-js";

interface UserDisplayMeta {
  avatarUrl: string | null;
  displayName: string | null;
}

/**
 * Extracts display-oriented fields from Supabase user_metadata.
 * OAuth providers (Google, etc.) populate avatar_url, full_name, and name;
 * email-only accounts leave metadata empty, so email is the fallback.
 */
export function extractUserDisplayMeta(user: User | null | undefined): UserDisplayMeta {
  const meta = user?.user_metadata as
    | { avatar_url?: string; full_name?: string; name?: string }
    | undefined;
  return {
    avatarUrl: meta?.avatar_url ?? null,
    displayName: meta?.full_name ?? meta?.name ?? user?.email ?? null,
  };
}
