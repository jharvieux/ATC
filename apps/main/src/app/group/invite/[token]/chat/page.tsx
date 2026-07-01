// §19.x — Anonymous invitee group chat page. Destination of the group
// landing page's "Open Group Chat →" link (specs/design_handoff_group_
// landing/). No session/role check — data comes straight from the
// HMAC-token-gated guest forum API (app/api/groups/invite/[token]/forum/**).
//
// Thin utility page, not the conversion-critical landing page: no skeleton
// loaders, no moderation UI (lock/pin/flag are coordinator-only and this
// page has no is_coordinator concept at all — see permissions.ts's canPost,
// which the API routes already enforce server-side).

import type { ReactElement } from "react";
import { quicksand } from "@/lib/fonts/quicksand";
import { GroupChatClient } from "@/components/group-invite/GroupChatClient";

type PageProps = { params: Promise<{ token: string }> };

interface ForumThread {
  id: string;
  title: string;
  is_locked: boolean;
  is_pinned: boolean;
  is_announcement: boolean;
  created_at: string;
}

interface ForumData {
  forum_id: string;
  is_locked: boolean;
  threads: ForumThread[];
}

async function fetchForum(token: string, origin: string): Promise<{ data?: ForumData; error?: string }> {
  const res = await fetch(`${origin}/api/groups/invite/${encodeURIComponent(token)}/forum`, { cache: "no-store" });
  const body = await res.json() as ForumData & { error?: string };
  if (!res.ok) return { error: body.error ?? "unknown_error" };
  return { data: body };
}

export default async function GroupChatPage(props: PageProps): Promise<ReactElement> {
  const params = await props.params;
  // Mirrors the origin resolution in ../page.tsx (InvitePage) for consistency.
  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL
    ? (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")
    : "http://localhost:3000";

  const { data, error } = await fetchForum(params.token, origin);

  return (
    <main
      data-cruise-theme="light"
      className={`${quicksand.variable} min-h-screen bg-[var(--cruise-bg)] text-[var(--cruise-text)]`}
    >
      <div className="max-w-[680px] mx-auto px-4 py-8">
        <h1 className="text-[22px] font-semibold mb-6" style={{ fontFamily: "var(--font-quicksand)" }}>
          Group Chat
        </h1>
        {error || !data ? (
          <p className="text-sm text-[var(--cruise-text-muted)]">
            {error === "forum_not_found"
              ? "This group doesn't have a chat yet."
              : "This chat isn't available right now."}
          </p>
        ) : (
          <GroupChatClient token={params.token} initialForum={data} />
        )}
      </div>
    </main>
  );
}
