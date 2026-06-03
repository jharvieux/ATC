// BP39 §33.7.2 — render assistant message content with display-asset markup.
//
// HYPERLINK approach (operator override of the spec's inline image
// rendering — see MEMORY D-075). Parses `[[display_asset:<uuid>]]`
// markers and replaces them with an `<a>` link to the asset's image_url
// plus an attribution sub-line. Unknown UUIDs (shouldn't appear after
// the BP39 asset-id-validation hallucination layer, but defense-in-depth
// here too) render as literal text — the customer sees the noise so
// telemetry has a signal.
//
// All asset-derived text is HTML-escaped by React's interpolation —
// caption, attribution, kind are placed as text nodes, not innerHTML.

import React from "react";

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
    if (asset && renderedAssetCount < MAX_RENDERED_ASSETS) {
      renderedAssetCount += 1;
      out.push(
        <span key={`asset-${key++}`} className="inline-block my-0.5">
          <a
            href={asset.image_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            View {asset.kind.replace(/_/g, " ")} ↗
          </a>
          {asset.attribution ? (
            <span className="ml-1.5 text-muted-foreground text-[12px]">
              ({asset.attribution})
            </span>
          ) : null}
        </span>,
      );
    } else if (asset) {
      // §33.7.2 #5 — beyond the cap. Drop the markup silently; the model
      // already had a ≤3 instruction in the prompt block.
    } else {
      // Unknown ID — render markup literally so the issue is visible.
      out.push(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) out.push(content.slice(lastIndex));

  return <>{out}</>;
}
