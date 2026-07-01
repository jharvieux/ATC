// Group-landing redesign — pure display-mapping helpers for the customer
// invite page's roster/social-proof section. No DB access here; callers
// fetch rows and pass them in.

const AVATAR_PALETTE = [
  "ocean-blue",
  "sun-yellow",
  "coral",
  "success-green",
] as const;

export type AvatarColor = (typeof AVATAR_PALETTE)[number];

// First name + last initial (e.g. "Jenna R."), matching the design's social
// proof copy. invitee_name is optional on invitations — coordinators aren't
// required to supply one — so a nameless invitee falls back to a generic
// label rather than ever surfacing their email address.
export function deriveDisplayName(inviteeName: string | null): string {
  if (!inviteeName?.trim()) return "A guest";
  const parts = inviteeName.trim().split(/\s+/);
  const firstName = parts[0] ?? "A guest";
  if (parts.length === 1) return firstName;
  const lastName = parts[parts.length - 1] ?? "";
  const lastInitial = lastName[0] ?? "";
  return `${firstName} ${lastInitial}.`;
}

// Deterministic (not random) so the same invitee always gets the same swatch
// across page loads — a stable hash of the invitation id, not its content.
export function avatarColorForId(id: string): AvatarColor {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[index] ?? AVATAR_PALETTE[0];
}
