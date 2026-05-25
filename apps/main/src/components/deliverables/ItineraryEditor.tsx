"use client";

// BP39 §39.7 — Agent edit panel for the trip itinerary.
//
// Drop into a booking detail page. Generates the itinerary draft on
// first use, lets the agent edit notes + send (regenerates PDF + flips
// status to 'sent'). Surfaces the customer-facing URL with a copy button.

import { useCallback, useEffect, useState } from "react";

type Itinerary = {
  id: string;
  access_token: string;
  status: "draft" | "sent" | "archived";
  agent_notes: string | null;
  sent_at: string | null;
  pdf_storage_key: string | null;
};

export function ItineraryEditor(props: { booking_id: string }): JSX.Element {
  const [itin, setItin] = useState<Itinerary | null>(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/bookings/${props.booking_id}/itinerary`);
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as { itinerary: Itinerary | null };
      setItin(data.itinerary);
      setNotes(data.itinerary?.agent_notes ?? "");
    } finally {
      setLoading(false);
    }
  }, [props.booking_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/bookings/${props.booking_id}/itinerary`, { method: "POST" });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as { itinerary: Itinerary };
      setItin(data.itinerary);
      setNotes(data.itinerary.agent_notes ?? "");
    } finally {
      setBusy(false);
    }
  };

  const save = async (send: boolean) => {
    if (!itin) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/itineraries/${itin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_notes: notes, send }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as Itinerary;
      setItin(data);
    } finally {
      setBusy(false);
    }
  };

  const rotateToken = async () => {
    if (!itin) return;
    if (!confirm("Rotate the customer link? The old URL stops working.")) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/itineraries/${itin.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rotate_token: true }),
      });
      if (r.ok) {
        const data = (await r.json()) as Itinerary;
        setItin(data);
      }
    } finally {
      setBusy(false);
    }
  };

  const publicUrl = itin ? `${window.location.origin}/i/${itin.access_token}` : "";

  if (loading) return <div className="text-sm text-gray-500">Loading itinerary…</div>;

  if (!itin) {
    return (
      <div className="border border-dashed border-gray-300 rounded-md p-4 text-center">
        <p className="text-sm text-gray-600 mb-2">No itinerary generated for this booking yet.</p>
        <button
          onClick={() => void generate()}
          disabled={busy}
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          Generate itinerary
        </button>
        {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
      </div>
    );
  }

  return (
    <div className="border border-gray-200 rounded-md p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Trip itinerary</h3>
        <span className={`text-xs px-2 py-0.5 rounded-full ${itin.status === "sent" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>
          {itin.status}
        </span>
      </div>

      <label className="block text-xs text-gray-600 mb-1">Agent notes</label>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={6}
        className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-3"
        placeholder="Personal notes for this customer…"
      />

      <div className="flex flex-wrap gap-2 mb-3">
        <button
          onClick={() => void save(false)}
          disabled={busy}
          className="bg-white border border-gray-300 text-gray-700 px-3 py-1 rounded text-sm hover:bg-gray-50 disabled:opacity-50"
        >
          Save draft
        </button>
        <button
          onClick={() => void save(true)}
          disabled={busy}
          className="bg-blue-600 text-white px-3 py-1 rounded text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {itin.status === "sent" ? "Save & re-send" : "Send"}
        </button>
      </div>

      {itin.status === "sent" && (
        <div className="border-t border-gray-200 pt-3">
          <label className="block text-xs text-gray-600 mb-1">Customer link</label>
          <div className="flex gap-2 items-center">
            <input type="text" readOnly value={publicUrl} className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs font-mono" />
            <button
              onClick={() => {
                void navigator.clipboard.writeText(publicUrl).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
              className="bg-white border border-gray-300 text-gray-700 px-2 py-1 rounded text-xs hover:bg-gray-50"
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              onClick={() => void rotateToken()}
              disabled={busy}
              className="text-xs text-amber-700 hover:underline disabled:opacity-50"
              title="Rotate the access token — invalidates the old link"
            >
              Rotate
            </button>
          </div>
          {itin.pdf_storage_key && (
            <div className="text-xs text-gray-500 mt-2">PDF generated · last regen on send</div>
          )}
        </div>
      )}

      {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
    </div>
  );
}
