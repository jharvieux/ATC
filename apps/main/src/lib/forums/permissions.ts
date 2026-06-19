// §19.2 — Posting and moderation permission checks for forum endpoints.
// Called as the first step in every forum API handler.

export interface ForumPermissionUser {
  id: string;
  role: string;
  is_coordinator: boolean;
}

export interface ForumPermissionForum {
  is_locked: boolean;
  coordinator_user_id: string;
}

export interface ForumPermissionThread {
  is_locked: boolean;
}

export interface ForumPermissionInvitation {
  rsvp_state: string;
}

export interface ForumPermissionMuteState {
  is_muted: boolean;
  muted_until: string | null;
}

export function canPost({
  user,
  forum,
  thread,
  muteState,
  invitation,
}: {
  user: ForumPermissionUser;
  forum: ForumPermissionForum;
  thread: ForumPermissionThread;
  muteState: ForumPermissionMuteState | null;
  invitation: ForumPermissionInvitation | null;
}): boolean {
  const isCoordinatorOrAdmin = user.is_coordinator || user.role === "platform_admin";

  if (forum.is_locked && !isCoordinatorOrAdmin) return false;
  if (thread.is_locked && !isCoordinatorOrAdmin) return false;

  if (muteState?.is_muted) {
    if (!muteState.muted_until) return false;
    if (new Date(muteState.muted_until) > new Date()) return false;
  }

  if (invitation?.rsvp_state === "not_going") return false;

  return true;
}

export function canModerate({
  user,
  forum,
}: {
  user: ForumPermissionUser;
  forum: ForumPermissionForum;
}): boolean {
  return user.is_coordinator || user.role === "platform_admin";
}

// #1190: a forum has no coordinator_user_id column — the coordinator lives on
// the linked group (forums.group_id → groups). Routes embed
// `groups(coordinator_user_id)`; supabase-js may return a to-one relation as an
// object or a single-element array, so normalize both shapes here.
export function forumCoordinatorId(
  forum: { groups?: unknown } | null | undefined,
): string | null {
  const rel = forum?.groups;
  const group = Array.isArray(rel) ? rel[0] : rel;
  return (group as { coordinator_user_id?: string | null } | null | undefined)?.coordinator_user_id ?? null;
}
