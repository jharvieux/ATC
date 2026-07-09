// Shared group constants — single source of truth so the create path
// (api/groups) and the single-invite path (api/groups/[id]/invitations)
// enforce the same 50-invitee cap. #1680: the two paths previously each
// carried their own literal `50`, so a future cap change could silently
// drift them apart.
export const MAX_INVITEES_PER_GROUP = 50;
