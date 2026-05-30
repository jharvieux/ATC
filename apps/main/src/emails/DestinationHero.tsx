// §23.4 — Shared destination hero image block for the four PreCruise
// email templates. Extracted so all four templates render identically
// (same border radius, same max-height, same alt-text wiring) rather
// than maintaining four near-copies of the same block.
//
// The Next.js `<Image />` rule doesn't apply to email templates; clients
// require raw <img> tags (no JS runtime to optimize).

/* eslint-disable @next/next/no-img-element */

import * as React from "react";
import type { DestinationImage } from "@/lib/cruise-regions/destination-images";

export function DestinationHero(props: {
  image: DestinationImage;
}): React.ReactElement {
  return (
    <div style={{ margin: "0 0 20px 0", overflow: "hidden", borderRadius: 8 }}>
      <img
        src={props.image.url}
        alt={props.image.alt_text}
        width="100%"
        style={{ display: "block", width: "100%", maxHeight: 280, objectFit: "cover" }}
      />
    </div>
  );
}
