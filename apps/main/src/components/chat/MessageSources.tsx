// §21.6 — Customer-facing source transparency.
//
// Subtle icon shown next to assistant messages that used RAG. Click expands
// a panel listing each cited source: title, ★ confidence, excerpt, and a
// "may be outdated" badge for §21.7 freshness flags.
//
// Visibility is controlled per-tenant by tenant_settings.show_chat_sources.
// When false, this component renders nothing — the persona still cites
// inline in prose; only the click-to-expand UI is hidden.

"use client";

import { useState } from "react";

export interface MessageCitation {
  chunk_id: string;
  title: string;
  source_url: string | null;
  confidence: number;
  stars: number;
  excerpt: string;
  is_outdated: boolean;
}

interface MessageSourcesProps {
  citations: MessageCitation[];
  visible?: boolean;
}

export function MessageSources({ citations, visible = true }: MessageSourcesProps) {
  const [open, setOpen] = useState(false);

  if (!visible || citations.length === 0) return null;

  return (
    <div className="mt-1 inline-block">
      <button
        type="button"
        aria-label={`Show ${citations.length} source${citations.length === 1 ? "" : "s"}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100"
      >
        <span aria-hidden="true">&#9432;</span>
        <span>{citations.length} source{citations.length === 1 ? "" : "s"}</span>
      </button>

      {open && (
        <ul className="mt-2 max-w-md space-y-2 rounded border border-slate-200 bg-white p-3 text-xs shadow">
          {citations.map((c) => (
            <li key={c.chunk_id} className="border-b border-slate-100 pb-2 last:border-b-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-slate-800">
                  {c.source_url ? (
                    <a href={c.source_url} target="_blank" rel="noreferrer noopener" className="underline">
                      {c.title}
                    </a>
                  ) : (
                    c.title
                  )}
                </span>
                <span aria-label={`${c.stars} of 5 stars`} className="text-amber-500">
                  {"★".repeat(c.stars)}
                  {"☆".repeat(5 - c.stars)}
                </span>
              </div>
              {c.is_outdated && (
                <span className="mt-1 inline-block rounded bg-amber-100 px-1 text-[10px] uppercase tracking-wide text-amber-900">
                  may be outdated
                </span>
              )}
              <p className="mt-1 text-slate-600">{c.excerpt}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
