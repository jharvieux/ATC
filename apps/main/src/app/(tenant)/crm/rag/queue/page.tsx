"use client";

// §22.5 — Tenant RAG submission review queue.
//
// Lists submissions in review_status='ready_for_review' with normalization
// preview, then lets the reviewer approve (with optional edits) or reject
// (with reason). Bulk-approve up to 10 without confirmation; >10 requires
// X-Bulk-Confirm header.

import React, { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const TEXT_INPUT_CLS =
  "rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500";

interface QueueItem {
  id: string;
  submission_method: string;
  source_url: string | null;
  source_title: string | null;
  extracted_content: string | null;
  redacted_content: string | null;
  normalization_result: {
    suggested_category?: string;
    suggested_tags?: string[];
    summary?: string;
    travel_segment?: string;
  } | null;
  pii_redaction_status: string;
  auto_flagged_for_global: boolean;
  content_hash: string;
  created_at: string;
}

const PAGE_SIZE = 25;

export default function RagQueuePage() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [acting, setActing] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/rag/queue", window.location.origin);
      url.searchParams.set("page", String(page));
      if (categoryFilter) url.searchParams.set("category", categoryFilter);
      if (sourceFilter) url.searchParams.set("source_type", sourceFilter);

      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`load_failed_${res.status}`);
      const data = (await res.json()) as { items: QueueItem[]; total: number };
      setItems(data.items);
      setTotal(data.total);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "load_failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, categoryFilter, sourceFilter]);

  function toggleSelect(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function approveOne(id: string) {
    setActing(true);
    setError(null);
    try {
      const res = await fetch(`/api/rag/queue/${id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        setError(d.error ?? "approve_failed");
        return;
      }
      await load();
    } finally {
      setActing(false);
    }
  }

  async function rejectOne(id: string) {
    const reason = window.prompt(
      "Why are you rejecting this submission? (Customer-facing notes — be specific so the next reviewer learns from this.)",
    );
    if (reason === null) return;
    setActing(true);
    setError(null);
    try {
      const res = await fetch(`/api/rag/queue/${id}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        setError(d.error ?? "reject_failed");
        return;
      }
      await load();
    } finally {
      setActing(false);
    }
  }

  async function bulkApprove() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    const confirm = ids.length > 10;
    if (confirm) {
      const ok = window.confirm(
        `Approve ${ids.length} submissions at once? Review each preview first — bulk approval is not reversible.`,
      );
      if (!ok) return;
    }
    setActing(true);
    setError(null);
    try {
      const res = await fetch("/api/rag/queue/bulk-approve", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(confirm ? { "X-Bulk-Confirm": "true" } : {}),
        },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        setError(d.error ?? "bulk_approve_failed");
        return;
      }
      await load();
    } finally {
      setActing(false);
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-semibold mb-2">RAG Submission Queue</h1>
      <p className="text-gray-500 mb-6">
        Review content your team submitted before it becomes searchable knowledge for the AI.
        Approve good content; reject anything that&apos;s incorrect, off-topic, or contains private
        customer info that wasn&apos;t caught by the redactor.
      </p>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">{error}</div>
      )}

      <div className="flex items-center gap-3 mb-4">
        <label className="text-sm flex items-center gap-2">
          Category:
          <input
            type="text"
            className={TEXT_INPUT_CLS + " w-40"}
            value={categoryFilter}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCategoryFilter(e.target.value)}
            placeholder="any"
          />
        </label>
        <label className="text-sm flex items-center gap-2">
          Source:
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="border rounded px-2 py-1 text-sm"
          >
            <option value="">Any source</option>
            <option value="web_ui">Web form</option>
            <option value="extension">Browser extension</option>
            <option value="ios_shortcut">iOS shortcut</option>
            <option value="file">File upload</option>
            <option value="batch">Batch import</option>
          </select>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-gray-500">
            {selected.size > 0 ? `${selected.size} selected` : `${total} pending`}
          </span>
          <Button
            onClick={bulkApprove}
            disabled={selected.size === 0 || acting}
            variant="default"
          >
            Bulk approve
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading queue…</p>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-gray-500">
            <p className="font-medium">Queue is empty.</p>
            <p className="text-sm mt-1">Content submitted by your team will appear here for review.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <Card key={item.id}>
              <CardContent className="py-3">
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggleSelect(item.id)}
                    aria-label={`Select ${item.source_title ?? item.id}`}
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium truncate">
                          {item.source_title ?? item.source_url ?? "(no title)"}
                        </p>
                        <p className="text-xs text-gray-500 mt-1 flex items-center gap-3 flex-wrap">
                          <span>via {item.submission_method}</span>
                          {item.normalization_result?.suggested_category && (
                            <span>category: {item.normalization_result.suggested_category}</span>
                          )}
                          {item.auto_flagged_for_global && (
                            <span className="text-amber-700">flagged: candidate for global library</span>
                          )}
                          {item.pii_redaction_status === "redacted" && (
                            <span className="text-blue-700">PII redacted</span>
                          )}
                          <span>{new Date(item.created_at).toLocaleString()}</span>
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          className="text-sm text-blue-600 underline"
                          onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                        >
                          {expandedId === item.id ? "Hide preview" : "Preview"}
                        </button>
                        <Button variant="outline" onClick={() => void rejectOne(item.id)} disabled={acting}>
                          Reject
                        </Button>
                        <Button onClick={() => void approveOne(item.id)} disabled={acting}>
                          Approve
                        </Button>
                      </div>
                    </div>
                    {expandedId === item.id && (
                      <div className="mt-3 border-t pt-3 space-y-2 text-sm">
                        {item.normalization_result?.summary && (
                          <p className="text-gray-700">
                            <strong>AI summary:</strong> {item.normalization_result.summary}
                          </p>
                        )}
                        {item.normalization_result?.suggested_tags && item.normalization_result.suggested_tags.length > 0 && (
                          <p className="text-xs text-gray-500">
                            Tags: {item.normalization_result.suggested_tags.join(", ")}
                          </p>
                        )}
                        <details className="text-xs">
                          <summary className="cursor-pointer text-gray-600">Raw content</summary>
                          <pre className="whitespace-pre-wrap text-gray-700 mt-2 max-h-72 overflow-auto">
                            {item.redacted_content ?? item.extracted_content ?? "(empty)"}
                          </pre>
                        </details>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-6">
          <Button variant="outline" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
            Previous
          </Button>
          <span className="text-sm text-gray-600">
            Page {page} of {pages}
          </span>
          <Button variant="outline" onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page === pages}>
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
