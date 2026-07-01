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
  const origin = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  const { data, error } = await fetchForum(params.token, origin);

  // GroupChatClient owns the data-cruise-theme wrapper (dynamic, synced via
  // useCruiseTheme) rather than this server component hardcoding a static
  // value — a hardcoded attribute here would sit closer to the content than
  // document.documentElement and win the CSS custom-property cascade,
  // silently defeating the live theme sync for every visitor in dark mode.
  return <GroupChatClient token={params.token} initialForum={data ?? null} error={error ?? null} />;
}
