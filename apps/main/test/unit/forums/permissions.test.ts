// §19.2 — Forum posting and moderation permission tests.
//
// Why these tests matter: fail-open permission bugs let muted/rejected
// invitees spam threads. Coordinator-only actions must never allow invitees.

import { describe, it, expect } from "vitest";
import { canPost, canModerate } from "@/lib/forums/permissions";

const regularUser = { id: "u1", role: "customer", is_coordinator: false };
const coordinator = { id: "u2", role: "customer", is_coordinator: true };
const platformAdmin = { id: "u3", role: "platform_admin", is_coordinator: false };

const openForum = { is_locked: false, coordinator_user_id: "u2" };
const lockedForum = { is_locked: true, coordinator_user_id: "u2" };

const openThread = { is_locked: false };
const lockedThread = { is_locked: true };

const goingInvitation = { rsvp_state: "interested" };
const notGoingInvitation = { rsvp_state: "not_going" };

const activeMute = { is_muted: true, muted_until: null };
const expiredMute = { is_muted: true, muted_until: new Date(Date.now() - 1000).toISOString() };
const futureMute = { is_muted: true, muted_until: new Date(Date.now() + 3_600_000).toISOString() };

describe("canPost — §19.2", () => {
  it("regular user can post in open forum, open thread", () => {
    expect(canPost({ user: regularUser, forum: openForum, thread: openThread, muteState: null, invitation: goingInvitation })).toBe(true);
  });

  it("muted user (permanent) cannot post", () => {
    expect(canPost({ user: regularUser, forum: openForum, thread: openThread, muteState: activeMute, invitation: goingInvitation })).toBe(false);
  });

  it("muted user with expired mute can post again", () => {
    expect(canPost({ user: regularUser, forum: openForum, thread: openThread, muteState: expiredMute, invitation: goingInvitation })).toBe(true);
  });

  it("user with future mute cannot post", () => {
    expect(canPost({ user: regularUser, forum: openForum, thread: openThread, muteState: futureMute, invitation: goingInvitation })).toBe(false);
  });

  it("not-going invitee cannot post", () => {
    expect(canPost({ user: regularUser, forum: openForum, thread: openThread, muteState: null, invitation: notGoingInvitation })).toBe(false);
  });

  it("regular user cannot post in locked forum", () => {
    expect(canPost({ user: regularUser, forum: lockedForum, thread: openThread, muteState: null, invitation: goingInvitation })).toBe(false);
  });

  it("coordinator can post in locked forum", () => {
    expect(canPost({ user: coordinator, forum: lockedForum, thread: openThread, muteState: null, invitation: goingInvitation })).toBe(true);
  });

  it("platform admin can post in locked forum", () => {
    expect(canPost({ user: platformAdmin, forum: lockedForum, thread: openThread, muteState: null, invitation: goingInvitation })).toBe(true);
  });

  it("regular user cannot post in locked thread", () => {
    expect(canPost({ user: regularUser, forum: openForum, thread: lockedThread, muteState: null, invitation: goingInvitation })).toBe(false);
  });

  it("coordinator can post in locked thread", () => {
    expect(canPost({ user: coordinator, forum: openForum, thread: lockedThread, muteState: null, invitation: goingInvitation })).toBe(true);
  });
});

describe("canModerate — §19.2", () => {
  it("coordinator can moderate", () => {
    expect(canModerate({ user: coordinator, forum: openForum })).toBe(true);
  });

  it("platform admin can moderate", () => {
    expect(canModerate({ user: platformAdmin, forum: openForum })).toBe(true);
  });

  it("regular user cannot moderate", () => {
    expect(canModerate({ user: regularUser, forum: openForum })).toBe(false);
  });
});
