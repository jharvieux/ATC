// Group-landing redesign heading font (specs/design_handoff_group_landing/).
// Loaded once here, applied via `quicksand.variable` on the cruise-theme
// route trees — not the root layout, so it doesn't affect the rest of the
// app's Geist typography.

import { Quicksand } from "next/font/google";

export const quicksand = Quicksand({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-quicksand",
});
