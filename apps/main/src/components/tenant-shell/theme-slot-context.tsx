import { createContext, useContext } from "react";

// Provides the DOM element that ConciergeExperience portals its theme
// toggle button into. TenantShell writes the element via a callback ref;
// ConciergeExperience reads it. Using context instead of getElementById
// avoids duplicate HTML IDs when both SiteHeader and TenantShell exist
// in the component tree (see issue #1304).
export const ThemeSlotContext = createContext<HTMLSpanElement | null>(null);

export function useThemeSlot(): HTMLSpanElement | null {
  return useContext(ThemeSlotContext);
}
