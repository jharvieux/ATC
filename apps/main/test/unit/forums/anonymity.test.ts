// §19.6 — Forum anonymity resolution tests.
//
// Why these tests matter: leaking a user's real identity in an anonymous
// forum thread is a trust violation. Coordinator must always see real names.

import { describe, it, expect } from "vitest";
import { effectiveForumDisplay } from "@/lib/forums/anonymity";

const alice: Parameters<typeof effectiveForumDisplay>[0]["user"] = {
  id: "user-alice",
  display_name: "Alice Smith",
  avatar_url: "https://example.com/alice.jpg",
};

const viewerInvitee = { id: "user-bob", is_coordinator: false, role: "customer" };
const viewerCoordinator = { id: "user-coord", is_coordinator: true, role: "customer" };
const viewerPlatformAdmin = { id: "user-admin", is_coordinator: false, role: "platform_admin" };
const viewerSelf = { id: "user-alice", is_coordinator: false, role: "customer" };

describe("effectiveForumDisplay — §19.6", () => {
  it("invitee viewing anonymous user sees Anonymous Traveler", () => {
    const result = effectiveForumDisplay({
      user: alice,
      invitation: { visibility_choice: "be_anonymous" },
      viewer: viewerInvitee,
    });
    expect(result.display_name).toBe("Anonymous Traveler");
    expect(result.avatar_url).toContain("anonymous-avatar");
  });

  it("coordinator viewing anonymous user sees real name", () => {
    const result = effectiveForumDisplay({
      user: alice,
      invitation: { visibility_choice: "be_anonymous" },
      viewer: viewerCoordinator,
    });
    expect(result.display_name).toBe("Alice Smith");
    expect(result.avatar_url).toBe("https://example.com/alice.jpg");
  });

  it("platform admin viewing anonymous user sees real name", () => {
    const result = effectiveForumDisplay({
      user: alice,
      invitation: { visibility_choice: "be_anonymous" },
      viewer: viewerPlatformAdmin,
    });
    expect(result.display_name).toBe("Alice Smith");
  });

  it("user viewing their own message sees their real name even if anonymous", () => {
    const result = effectiveForumDisplay({
      user: alice,
      invitation: { visibility_choice: "be_anonymous" },
      viewer: viewerSelf,
    });
    expect(result.display_name).toBe("Alice Smith");
  });

  it("invitee who chose show_me_anyway is shown with real name", () => {
    const result = effectiveForumDisplay({
      user: alice,
      invitation: { visibility_choice: "show_me_anyway" },
      viewer: viewerInvitee,
    });
    expect(result.display_name).toBe("Alice Smith");
  });

  it("null invitation (no invitation record) → anonymous to other invitees", () => {
    const result = effectiveForumDisplay({
      user: alice,
      invitation: null,
      viewer: viewerInvitee,
    });
    expect(result.display_name).toBe("Anonymous Traveler");
  });
});
