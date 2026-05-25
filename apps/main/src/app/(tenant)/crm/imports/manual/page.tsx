"use client";

// BP34 §34.6 / §34.1 — Manual entry form.
//
// Hits POST /api/imports/manual with the text body + optional document
// type hint. After submission, the pipeline classifies/extracts; the
// agent is sent to the pending-review list to track the row.

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function ManualImportPage() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (text.trim().length === 0) {
      setError("Enter the lead text or paste the email body.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/imports/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          ...(hint ? { document_type_hint: hint } : {}),
        }),
      });
      if (r.ok) {
        router.push("/crm/imports");
        return;
      }
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? "submission_failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="mb-6">
        <a href="/crm/imports" className="text-sm text-blue-600 hover:underline">
          ← Back to pending review
        </a>
        <h1 className="text-2xl font-semibold mt-2">Manual entry</h1>
        <p className="text-sm text-gray-500 mt-1">
          Paste a forwarded email body, lead-board screenshot transcript, or hand-typed details.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-semibold mb-1">Document type (optional)</label>
          <select
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm"
          >
            <option value="">Auto-classify</option>
            <option value="lead_notification">Lead notification</option>
            <option value="booking_confirmation">Booking confirmation</option>
            <option value="commission_statement">Commission statement</option>
            <option value="intake_form">Intake form</option>
          </select>
          <p className="text-xs text-gray-500 mt-1">
            If left blank, the system classifies via AI; supplying a hint skips classification.
          </p>
        </div>

        <div>
          <label className="block text-sm font-semibold mb-1">Body</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={16}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono"
            placeholder="Paste the lead details here…"
          />
          <p className="text-xs text-gray-500 mt-1">Up to 100KB of plain text.</p>
        </div>

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <button
            disabled={busy}
            onClick={() => void submit()}
            className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Submit to pipeline"}
          </button>
          <a
            href="/crm/imports"
            className="bg-white border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-50"
          >
            Cancel
          </a>
        </div>
      </div>
    </div>
  );
}
