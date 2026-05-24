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

/**
 * Render an assistant message body with inline display-asset hyperlinks.
 * Pure function — no DOM, easily testable.
 */
export function renderMessageContent(
  content: string,
  assets: DisplayAsset[] | undefined,
): React.ReactNode {
  const byId = new Map<string, DisplayAsset>();
  for (const a of assets ?? []) byId.set(a.asset_id.toLowerCase(), a);

  const out: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  MARKUP_RE.lastIndex = 0;
  while ((match = MARKUP_RE.exec(content)) !== null) {
    if (match.index > lastIndex) {
      out.push(content.slice(lastIndex, match.index));
    }
    const id = (match[1] ?? "").toLowerCase();
    const asset = UUID_RE.test(id) ? byId.get(id) : undefined;
    if (asset) {
      out.push(
        <span key={`asset-${key++}`} style={{ display: "inline-block", margin: "2px 0" }}>
          <a
            href={asset.image_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "#2563eb", textDecoration: "underline" }}
          >
            View {asset.kind.replace(/_/g, " ")} ↗
          </a>
          {asset.attribution ? (
            <span style={{ marginLeft: 6, color: "#6b7280", fontSize: 12 }}>
              ({asset.attribution})
            </span>
          ) : null}
        </span>,
      );
    } else {
      // Unknown ID — render markup literally so the issue is visible.
      out.push(match[0]);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) out.push(content.slice(lastIndex));

  return <>{out}</>;
}
