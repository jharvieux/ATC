// Shares the staff dashboard's conversation-rail collapse state between the
// TenantShell top bar (where the PanelLeft toggle lives) and
// ConciergeExperience (which owns the actual rail). TenantShell renders the
// children inside this provider, so the rail can read `open` without
// prop-drilling through the server page that sits between them.
//
// Viewers (ChatExperience) render outside any provider — useConversationRail
// then returns an inert default, so the hook is safe to call unconditionally
// and the toggle simply never appears for non-staff.

"use client";

import * as React from "react";

export interface ConversationRailState {
  /** Tri-state width control (matches the old nav-rail idiom): null = CSS
   *  default (closed below lg, open lg+, no hydration flash), true = open,
   *  false = closed. */
  open: boolean | null;
  toggle: () => void;
}

const ConversationRailContext =
  React.createContext<ConversationRailState | null>(null);

export function useConversationRail(): ConversationRailState {
  return (
    React.useContext(ConversationRailContext) ?? { open: null, toggle: () => {} }
  );
}

export { ConversationRailContext };
