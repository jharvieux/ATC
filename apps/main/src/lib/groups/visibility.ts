// §18.6 — Anonymity floor for group cabin grid.
//
// Truth table (coordinator wins when in conflict):
//   visible  + no_opinion     → visible
//   visible  + be_anonymous   → hidden
//   hidden   + no_opinion     → hidden
//   hidden   + show_me_anyway → hidden (coordinator floor wins)

export type VisibilityDefault = "visible" | "hidden";
export type VisibilityChoice = "no_opinion" | "be_anonymous" | "show_me_anyway";

export function effectiveVisibility(
  groupVisibilityDefault: VisibilityDefault,
  inviteeVisibilityChoice: VisibilityChoice,
): "visible" | "hidden" {
  if (groupVisibilityDefault === "hidden") return "hidden";
  if (inviteeVisibilityChoice === "be_anonymous") return "hidden";
  return "visible";
}
