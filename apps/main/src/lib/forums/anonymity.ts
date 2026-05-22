// §19.6 — Forum anonymity resolution.
//
// The stored user_id is never changed. Only the rendered display name/avatar
// is masked when an invitee has chosen anonymity and the forum's coordinator
// visibility default is "hidden".

const ANONYMOUS_DISPLAY_NAME = "Anonymous Traveler";
const ANONYMOUS_AVATAR_URL = "https://cdn.ai-travelconcierge.com/defaults/anonymous-avatar.png";

export interface ForumDisplayUser {
  id: string;
  display_name: string;
  avatar_url: string | null;
}

export interface ForumDisplayInvitation {
  visibility_choice: "no_opinion" | "be_anonymous" | "show_me_anyway";
}

export interface ForumDisplayViewer {
  id: string;
  is_coordinator: boolean;
  role: string;
}

export function effectiveForumDisplay({
  user,
  invitation,
  viewer,
}: {
  user: ForumDisplayUser;
  invitation: ForumDisplayInvitation | null;
  viewer: ForumDisplayViewer;
}): { display_name: string; avatar_url: string | null } {
  // Coordinators and platform admins always see real identities.
  if (viewer.is_coordinator || viewer.role === "platform_admin") {
    return { display_name: user.display_name, avatar_url: user.avatar_url };
  }

  // The viewer seeing their own message always sees their own name.
  if (viewer.id === user.id) {
    return { display_name: user.display_name, avatar_url: user.avatar_url };
  }

  // If the invitee chose anonymity (or has no invitation record), mask.
  if (!invitation || invitation.visibility_choice === "be_anonymous") {
    return { display_name: ANONYMOUS_DISPLAY_NAME, avatar_url: ANONYMOUS_AVATAR_URL };
  }

  return { display_name: user.display_name, avatar_url: user.avatar_url };
}
