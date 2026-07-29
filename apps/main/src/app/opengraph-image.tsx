// Default social card for every route that doesn't define its own.
//
// Generated rather than shipped as a static asset so it can't drift from the
// positioning, and so there's no binary in the repo to re-export whenever the
// wording changes. No custom font is loaded: fetching one at render time adds
// a network dependency to image generation for a card most viewers see at
// thumbnail size.

import { ImageResponse } from "next/og";

export const alt =
  "AI Travel Concierge — AI software for independent cruise agents";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Matches the deep navy the pricing component already uses for its
// selected-state chips.
const NAVY = "#0a2540";

export default async function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          backgroundColor: NAVY,
          padding: "80px",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            fontSize: 26,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "#7dd3fc",
            fontWeight: 600,
          }}
        >
          AI Travel Concierge
        </div>
        <div
          style={{
            marginTop: 28,
            fontSize: 76,
            lineHeight: 1.1,
            color: "#ffffff",
            fontWeight: 700,
          }}
        >
          Sell more cruises in half the time.
        </div>
        <div
          style={{
            marginTop: 32,
            fontSize: 32,
            lineHeight: 1.35,
            color: "#cbd5e1",
          }}
        >
          Six AI cruise specialists quote, research, and follow up for you.
          Bring your own host agency — keep 100% of your commission.
        </div>
      </div>
    ),
    size,
  );
}
