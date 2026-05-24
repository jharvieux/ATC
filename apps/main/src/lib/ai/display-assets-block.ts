// BP39 §33.7.1 — DISPLAYABLE ASSETS prompt block.
//
// Renders the prompt fragment that lists assets the AI is allowed to
// reference in its response. The fragment is appended AFTER the
// knowledge_block, before the tone calibration.
//
// **HYPERLINK approach** (operator direction; the addendum spec §33.7.2
// references inline image rendering, but the operator opted for hyperlinks
// to avoid the in-chat image hosting + bandwidth + UI surface area;
// see MEMORY D-075). The DISPLAY INSTRUCTIONS reflect this — the model
// emits `[[display_asset:<uuid>]]` markup which the consumer client
// renders as a hyperlink ("View deck plan ↗") pointing at the asset's
// image_url, NOT an <img> element.
//
// Build-time choice: inline markup over tool calls. Justified in MEMORY
// because the per-turn payload is small (<10 assets typical) and
// streaming-safe.

import type { RetrievedAsset } from "@/lib/rag/chunk-types";

/**
 * Build the DISPLAYABLE ASSETS prompt block. Returns the empty string
 * when there are no assets — the caller should NOT append an empty
 * section to the system prompt.
 */
export function buildDisplayableAssetsBlock(assets: RetrievedAsset[]): string {
  if (assets.length === 0) return "";

  const entries = assets
    .map((a) => {
      const caption = a.caption ? a.caption.replace(/[\r\n]+/g, " ").trim() : "(no caption)";
      return `- id: ${a.asset_id}  kind: ${a.kind}  caption: ${caption}`;
    })
    .join("\n");

  return [
    "DISPLAYABLE ASSETS — you may reference any of the following in your reply by emitting the markup [[display_asset:<id>]] inline at the point where it helps the reader. Use sparingly (at most 3 per reply, only when an asset directly answers the customer's question). Only emit IDs from this list. Do NOT invent IDs.",
    "",
    entries,
    "",
    "DISPLAY INSTRUCTIONS:",
    "- Emit [[display_asset:<id>]] inline, on its own line or at the end of a relevant sentence.",
    "- The client renders the markup as a hyperlink to the source image; you do not need to describe the markup or apologise for it.",
    "- If no asset directly helps, omit display markup entirely.",
  ].join("\n");
}
