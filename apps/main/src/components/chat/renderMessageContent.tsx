// BP39 §33.7.2 — render assistant message content with display-asset markup.
//
// Parses `[[display_asset:<uuid>]]` markers and replaces each with an
// <AssetLightbox> — a trigger + attribution that opens the image in an
// on-page modal (D-188 follow-up; the original D-075 design used a new-tab
// hyperlink, which navigated customers away to cruisemapper.com). We still
// hot-link the image rather than host it. Unknown UUIDs (shouldn't appear
// after the BP39 asset-id-validation layer, but defense-in-depth here too)
// and non-http(s) urls render as literal text — the customer sees the noise
// so telemetry has a signal.
//
// All asset-derived text is HTML-escaped by React's interpolation —
// caption, attribution, kind are placed as text nodes, not innerHTML.

import React from "react";
import { AssetLightbox } from "./AssetLightbox";

export interface DisplayAsset {
  asset_id: string;
  kind: string;
  image_url: string;
  source_page_url?: string | null;
  attribution: string;
  caption?: string | null;
}

const MARKUP_RE = /\[\[display_asset:([^\]]{1,80})\]\]/g;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// §33.7.2 point 5 — hard cap on rendered assets per response, regardless
// of how many markup tags the AI emits. The system prompt already
// instructs ≤3; this is the belt-and-braces enforcement.
const MAX_RENDERED_ASSETS = 3;

export interface RenderOptions {
  /** §21.6 tenant source-display toggle. When false, asset markup is
   *  stripped entirely (no link, no attribution) — the model may still
   *  emit `[[display_asset:...]]`, but the client doesn't surface it. */
  showAssetLinks?: boolean;
}

/**
 * Render an assistant message body with inline display-asset hyperlinks.
 * Pure function — no DOM, easily testable.
 */
export function renderMessageContent(
  content: string,
  assets: DisplayAsset[] | undefined,
  options: RenderOptions = {},
): React.ReactNode {
  const showAssetLinks = options.showAssetLinks ?? true;

  // Source-display toggle off → strip every well-formed marker and any
  // surrounding whitespace, return the cleaned content as plain text.
  if (!showAssetLinks) {
    const cleaned = content
      .replace(MARKUP_RE, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return <>{cleaned}</>;
  }

  const byId = new Map<string, DisplayAsset>();
  for (const a of assets ?? []) byId.set(a.asset_id.toLowerCase(), a);

  const out: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let renderedAssetCount = 0;
  let match: RegExpExecArray | null;
  MARKUP_RE.lastIndex = 0;
  while ((match = MARKUP_RE.exec(content)) !== null) {
    if (match.index > lastIndex) {
      out.push(content.slice(lastIndex, match.index));
    }
    const id = (match[1] ?? "").toLowerCase();
    const asset = UUID_RE.test(id) ? byId.get(id) : undefined;
    // Defense-in-depth: only hyperlink http(s) URLs. Assets come from the DB
    // scraper pipeline, not users, but an href is one place a stray
    // javascript:/data: URL must never reach. A non-http(s) url falls through
    // to literal rendering so the bad asset is visible, not clickable.
    const safeUrl = asset !== undefined && /^https?:\/\//i.test(asset.image_url);
    if (asset && safeUrl && renderedAssetCount < MAX_RENDERED_ASSETS) {
      renderedAssetCount += 1;
      // In-page lightbox (D-188 follow-up): clicking opens the image in a
      // modal on this page rather than navigating to cruisemapper.com.
      out.push(<AssetLightbox key={`asset-${key++}`} asset={asset} />);
    } else if (asset && safeUrl) {
      // §33.7.2 #5 — beyond the cap. Drop the markup silently; the model
      // already had a ≤3 instruction in the prompt block.
    } else {
      // Unknown ID, or an asset whose url isn't a safe http(s) link —
      // render markup literally so the issue is visible.
      out.push(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) out.push(content.slice(lastIndex));

  return <>{out}</>;
}
