"use client";

// BP34 §34.6 — Per-item review screen.
//
// Shows extracted fields (editable), source preview (text or signed-URL
// PDF link), validation flags, and the four actions: Accept as-is, Edit
// and accept, Merge with existing, Reject. The "merge" path is a stub
// today — when the agent picks it, we surface a contact-picker dialog
// in a follow-up.

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

interface ImportItem {
  id: string;
  import_path: "email" | "document" | "manual";
  source_ref: string;
  document_type: string | null;
  classification_confidence: number | null;
  extraction_overall_confidence: number | null;
  raw_extracted_fields: Record<string, unknown> | null;
  per_field_confidence: Record<string, number> | null;
  validation_flags: Array<{ flag: string; reason: string }> | null;
  parse_failure_reason: string | null;
  uploaded_file_path: string | null;
  created_at: string;
}

export default function ImportReviewItemPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [item, setItem] = useState<ImportItem | null>(null);
  const [editedFields, setEditedFields] = useState<Record<string, string>>({});
  const [commissionRate, setCommissionRate] = useState<string>("");
  const [rejectReason, setRejectReason] = useState<string>("");
  const [retainForFollowup, setRetainForFollowup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchItem = useCallback(async () => {
    // The review API only lists items; we re-use the list endpoint with no
    // pagination and pick. Simplest path until a single-item read endpoint
    // is added.
    const r = await fetch(`/api/imports/review?limit=200`);
    if (!r.ok) return;
    const data = (await r.json()) as { items: ImportItem[] };
    const found = data.items.find((it) => it.id === id);
    if (found) {
      setItem(found);
      const init: Record<string, string> = {};
      for (const [k, v] of Object.entries(found.raw_extracted_fields ?? {})) {
        if (v !== null && (typeof v === "string" || typeof v === "number")) {
          init[k] = String(v);
        }
      }
      setEditedFields(init);
    }
  }, [id]);

  useEffect(() => {
    void fetchItem();
  }, [fetchItem]);

  const onAccept = async (asEdited: boolean) => {
    setBusy(true);
    setError(null);
    const body: { edited_fields?: Record<string, unknown>; commission_rate?: number } = {};
    if (asEdited) {
      const edited: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(editedFields)) {
        // Try to coerce numbers back to numbers (cents fields).
        if (/_cents$/.test(k) || /^party_size$|^duration_nights$/.test(k)) {
          const n = Number(v);
          edited[k] = Number.isFinite(n) ? n : v;
        } else if (k === "commission_rate") {
          const n = Number(v);
          edited[k] = Number.isFinite(n) ? n : v;
        } else {
          edited[k] = v;
        }
      }
      body.edited_fields = edited;
    }
    if (commissionRate.trim()) {
      const n = Number(commissionRate);
      if (Number.isFinite(n)) body.commission_rate = n;
    }
    try {
      const r = await fetch(`/api/imports/review/${id}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        router.push("/crm/imports");
        return;
      }
      const j = (await r.json().catch(() => ({}))) as { error?: string; reason?: string };
      setError(j.reason ?? j.error ?? "accept_failed");
    } finally {
      setBusy(false);
    }
  };

  const onReject = async () => {
    if (!rejectReason.trim()) {
      setError("Reason is required for rejection.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/imports/review/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: rejectReason, retain_for_followup: retainForFollowup }),
      });
      if (r.ok) {
        router.push("/crm/imports");
        return;
      }
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "reject_failed");
    } finally {
      setBusy(false);
    }
  };

  if (!item) return <div className="p-6 text-gray-500">Loading…</div>;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <a href="/crm/imports" className="text-sm text-blue-600 hover:underline">
          ← Back to pending review
        </a>
        <h1 className="text-2xl font-semibold mt-2">
          {item.document_type ?? "(no classification)"}{" "}
          <span className="text-base text-gray-500 font-normal">
            via {item.import_path}
          </span>
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Source: <code className="bg-gray-100 px-1.5 py-0.5 rounded">{item.source_ref}</code> ·{" "}
          Received {new Date(item.created_at).toLocaleString()}
        </p>
      </div>

      {/* Flags */}
      {(item.validation_flags ?? []).length > 0 && (
        <div className="mb-4 border border-amber-200 bg-amber-50 rounded-md p-3">
          <h3 className="text-sm font-semibold text-amber-900 mb-1">Validation flags</h3>
          <ul className="text-sm text-amber-800 space-y-0.5">
            {(item.validation_flags ?? []).map((f, i) => (
              <li key={i}>
                <strong>{f.flag}</strong> — {f.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {item.parse_failure_reason && (
        <div className="mb-4 border border-red-200 bg-red-50 rounded-md p-3 text-sm text-red-800">
          <strong>Parse failure reason:</strong> {item.parse_failure_reason}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Extracted fields */}
        <div>
          <h2 className="text-sm font-semibold mb-2">Extracted fields</h2>
          <div className="space-y-2">
            {Object.keys(editedFields).length === 0 ? (
              <p className="text-sm text-gray-500">No fields extracted.</p>
            ) : (
              Object.entries(editedFields).map(([k, v]) => {
                const conf = item.per_field_confidence?.[k];
                return (
                  <div key={k}>
                    <label className="block text-xs text-gray-600 mb-0.5">
                      {k}
                      {conf !== undefined && (
                        <span className={`ml-2 ${conf < 0.6 ? "text-red-600" : "text-gray-400"}`}>
                          ({Math.round(conf * 100)}%)
                        </span>
                      )}
                    </label>
                    <input
                      type="text"
                      value={v}
                      onChange={(e) =>
                        setEditedFields({ ...editedFields, [k]: e.target.value })
                      }
                      className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm"
                    />
                  </div>
                );
              })
            )}
          </div>

          {/* §34.7.3 step 3 — agent rate entry when missing */}
          {item.parse_failure_reason === "commission_rate_missing" && (
            <div className="mt-4 border-t border-gray-200 pt-3">
              <label className="block text-xs text-gray-600 mb-0.5">
                Commission rate (decimal, e.g. 0.12 for 12%)
              </label>
              <input
                type="number"
                step="0.001"
                value={commissionRate}
                onChange={(e) => setCommissionRate(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm"
              />
            </div>
          )}
        </div>

        {/* Source preview */}
        <div>
          <h2 className="text-sm font-semibold mb-2">Source</h2>
          {item.uploaded_file_path ? (
            <p className="text-sm">
              <a
                href={`/api/imports/source-file?path=${encodeURIComponent(item.uploaded_file_path)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                View uploaded document →
              </a>
            </p>
          ) : item.import_path === "manual" ? (
            <pre className="bg-gray-50 border border-gray-200 rounded-md p-2 text-xs whitespace-pre-wrap max-h-64 overflow-auto">
              {item.source_ref}
            </pre>
          ) : (
            <p className="text-sm text-gray-500">
              Email source — view in Gmail (message id <code>{item.source_ref}</code>).
            </p>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="mt-8 border-t border-gray-200 pt-6">
        {error && (
          <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </div>
        )}
        <div className="flex gap-3 flex-wrap">
          <button
            disabled={busy}
            onClick={() => void onAccept(false)}
            className="bg-green-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-green-700 disabled:opacity-50"
          >
            Accept as-is
          </button>
          <button
            disabled={busy}
            onClick={() => void onAccept(true)}
            className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            Accept with edits
          </button>
        </div>

        <div className="mt-6 border-t border-gray-200 pt-4">
          <h3 className="text-sm font-semibold mb-2">Reject</h3>
          <input
            type="text"
            placeholder="Reason for rejection (required)"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm mb-2"
          />
          <label className="flex items-center gap-2 text-sm text-gray-700 mb-2">
            <input
              type="checkbox"
              checked={retainForFollowup}
              onChange={(e) => setRetainForFollowup(e.target.checked)}
            />
            Retain source for follow-up (7d instead of 24h)
          </label>
          <button
            disabled={busy}
            onClick={() => void onReject()}
            className="bg-red-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}
