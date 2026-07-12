"use client";

// BP34 §34.6 — Pending review list.
//
// Filters per §34.6.1: import_path, document_type, submitted_by_user_id.
// Bulk-accept selection for high-confidence batches.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FileDropZone } from "@/components/ui/file-drop-zone";

interface ImportItem {
  id: string;
  status: "pending_review" | "parse_failed";
  import_path: "email" | "document" | "manual";
  source_ref: string;
  document_type: string | null;
  classification_confidence: number | null;
  extraction_overall_confidence: number | null;
  raw_extracted_fields: Record<string, unknown> | null;
  validation_flags: Array<{ flag: string; reason: string }> | null;
  parse_failure_reason: string | null;
  submitted_by_user_id: string | null;
  uploaded_file_path: string | null;
  created_at: string;
}

interface ListResponse {
  items: ImportItem[];
  total: number;
  limit: number;
  offset: number;
}

export function ImportsView() {
  const [items, setItems] = useState<ImportItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pathFilter, setPathFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [bulkRunning, setBulkRunning] = useState(false);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (pathFilter) params.set("import_path", pathFilter);
    if (typeFilter) params.set("document_type", typeFilter);
    params.set("limit", "100");
    try {
      const r = await fetch(`/api/imports/review?${params}`);
      if (!r.ok) return;
      const data = (await r.json()) as ListResponse;
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
      setSelected(new Set());
    } finally {
      setLoading(false);
    }
  }, [pathFilter, typeFilter]);

  useEffect(() => {
    void fetchItems();
  }, [fetchItems]);

  const [retryingId, setRetryingId] = useState<string | null>(null);

  // parse_failed rows can't be accepted (the accept route requires
  // pending_review), so they're never selectable for bulk-accept.
  const selectableIds = items.filter((i) => i.status === "pending_review").map((i) => i.id);

  const toggleAll = (checked: boolean) => {
    if (checked) setSelected(new Set(selectableIds));
    else setSelected(new Set());
  };

  const retryOne = async (id: string) => {
    setRetryingId(id);
    try {
      const r = await fetch(`/api/imports/review/${id}/retry`, { method: "POST" });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        alert(`Retry failed: ${j.error ?? r.status}`);
        return;
      }
      void fetchItems();
    } finally {
      setRetryingId(null);
    }
  };

  const toggleOne = (id: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    setSelected(next);
  };

  const bulkAccept = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Accept ${selected.size} item${selected.size === 1 ? "" : "s"} as-is?`)) return;
    setBulkRunning(true);
    // Each accept targets a distinct import row — independent requests, so
    // fan out instead of one round-trip at a time. Per-item try/catch is
    // preserved so one failure doesn't block the rest of the batch.
    const results = await Promise.all(
      Array.from(selected).map(async (id) => {
        try {
          const r = await fetch(`/api/imports/review/${id}/accept`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          if (r.ok) return { id, ok: true, reason: undefined as string | undefined };
          const j = (await r.json().catch(() => ({ error: "unknown" }))) as { error?: string; reason?: string };
          return { id, ok: false, reason: j.reason ?? j.error ?? "unknown" };
        } catch (err) {
          return { id, ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    setBulkRunning(false);
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      alert(`Accepted ${results.length - failed.length}/${results.length}. Failed:\n` + failed.map((f) => `${f.id}: ${f.reason}`).join("\n"));
    }
    void fetchItems();
  };

  const summary = (it: ImportItem): string => {
    const f = it.raw_extracted_fields ?? {};
    const fields = f as Record<string, unknown>;
    const name = fields.contact_name ?? fields.cruise_line ?? fields.statement_period_start;
    return name ? String(name) : it.source_ref.slice(0, 60);
  };

  const confidence = (it: ImportItem): string => {
    const c = it.extraction_overall_confidence ?? it.classification_confidence;
    return c !== null && c !== undefined ? `${Math.round(c * 100)}%` : "—";
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Pending review</h1>
        <Link href="/crm/imports/manual" className="text-sm text-blue-600 hover:underline">
          + Manual entry
        </Link>
      </div>

      <FileDropZone
        accept="application/pdf,.pdf"
        acceptLabel="PDF only"
        maxBytes={10 * 1024 * 1024}
        endpoint="/api/imports/upload"
        onSuccess={() => { void fetchItems(); }}
        className="mb-6"
      />

      <div className="flex gap-3 mb-4">
        <select
          value={pathFilter}
          onChange={(e) => setPathFilter(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm"
        >
          <option value="">All sources</option>
          <option value="email">Email</option>
          <option value="document">Document</option>
          <option value="manual">Manual</option>
        </select>
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm"
        >
          <option value="">All types</option>
          <option value="lead_notification">Lead notification</option>
          <option value="booking_confirmation">Booking confirmation</option>
          <option value="commission_statement">Commission statement</option>
          <option value="intake_form">Intake form</option>
          <option value="unknown">Unknown</option>
        </select>
        {selected.size > 0 && (
          <button
            onClick={bulkAccept}
            disabled={bulkRunning}
            className="ml-auto bg-green-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
          >
            {bulkRunning ? "Accepting…" : `Bulk accept (${selected.size})`}
          </button>
        )}
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : (
        <>
          <p className="text-sm text-gray-500 mb-3">{total} pending</p>
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-4 py-3 w-8">
                    <input
                      type="checkbox"
                      checked={selectableIds.length > 0 && selected.size === selectableIds.length}
                      onChange={(e) => toggleAll(e.target.checked)}
                      aria-label="Select all"
                    />
                  </th>
                  <th className="text-left px-4 py-3">Summary</th>
                  <th className="text-left px-4 py-3">Source</th>
                  <th className="text-left px-4 py-3">Type</th>
                  <th className="text-left px-4 py-3">Conf.</th>
                  <th className="text-left px-4 py-3">Flags</th>
                  <th className="text-left px-4 py-3">Status</th>
                  <th className="text-left px-4 py-3">Received</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(it.id)}
                        disabled={it.status !== "pending_review"}
                        onChange={(e) => toggleOne(it.id, e.target.checked)}
                        aria-label={`Select ${it.id}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <a href={`/crm/imports/${it.id}`} className="text-blue-600 hover:underline">
                        {summary(it)}
                      </a>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{it.import_path}</td>
                    <td className="px-4 py-3 text-gray-600">{it.document_type ?? "—"}</td>
                    <td className="px-4 py-3 text-gray-600">{confidence(it)}</td>
                    <td className="px-4 py-3 text-gray-600">
                      {(it.validation_flags ?? []).length > 0 ? (
                        <span className="inline-block bg-amber-100 text-amber-800 rounded-full px-2 py-0.5 text-xs">
                          {(it.validation_flags ?? []).length}
                        </span>
                      ) : it.parse_failure_reason ? (
                        <span className="text-amber-700 text-xs">{it.parse_failure_reason}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {it.status === "parse_failed" ? (
                        <div className="flex items-center gap-2">
                          <span
                            title={it.parse_failure_reason ?? undefined}
                            className="inline-block bg-red-100 text-red-800 rounded-full px-2 py-0.5 text-xs"
                          >
                            Failed
                          </span>
                          <button
                            type="button"
                            onClick={() => retryOne(it.id)}
                            disabled={retryingId === it.id}
                            className="text-blue-600 hover:underline text-xs disabled:opacity-50"
                          >
                            {retryingId === it.id ? "Retrying…" : "Retry"}
                          </button>
                        </div>
                      ) : (
                        <span className="text-gray-400 text-xs">Pending review</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {new Date(it.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                      No items to review.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
