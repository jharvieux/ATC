import type { User } from "@supabase/supabase-js";

interface UserDisplayMeta {
  avatarUrl: string | null;
  displayName: string | null;
}

export function extractUserDisplayMeta(user: User | null | undefined): UserDisplayMeta {
  const meta = user?.user_metadata as
    | { avatar_url?: string; full_name?: string; name?: string }
    | undefined;
  return {
    avatarUrl: meta?.avatar_url ?? null,
    // full_name (Google) → name (GitHub) → email as last resort
    displayName: meta?.full_name ?? meta?.name ?? user?.email ?? null,
  };
}
