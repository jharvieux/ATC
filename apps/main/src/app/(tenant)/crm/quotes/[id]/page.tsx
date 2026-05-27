"use client";

// §12.4 — Quote detail with line-item editor.
// PDF rendering deferred per build prompt — TODO(bp21-pdf): wire @react-pdf/renderer.

import { useState, useEffect, use } from "react";
import { COMMISSIONABLE_LINE_ITEMS } from "@/lib/commissions/commissionable-line-items";

interface Quote {
  id: string;
  contact_id: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  passenger_count: number | null;
  commissionable_fare: number | null;
  non_commissionable_total: number | null;
  total_amount: number | null;
  status: string;
  custom_notes: string | null;
  show_breakdown_to_customer: boolean;
}

export default function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/quotes/${id}`)
      .then(async (res) => {
        if (!res.ok) { setError("Quote not found"); return; }
        const data: Quote = await res.json();
        setQuote(data);
      })
      .catch(() => setError("Failed to load quote"))
      .finally(() => setLoading(false));
  }, [id]);

  async function handleSend() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/quotes/${id}/send`, { method: "POST" });
      if (!res.ok) { setError("Send failed"); return; }
      const data: { quote: Quote } = await res.json();
      setQuote(data.quote);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="p-8 text-center">Loading…</div>;
  if (error || !quote) return <div className="p-8 text-center text-red-600">{error ?? "Not found"}</div>;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">
            {quote.cruise_line ?? "Quote"}{quote.ship_name ? ` — ${quote.ship_name}` : ""}
          </h1>
          <span className="text-sm text-gray-500 capitalize">{quote.status}</span>
        </div>
        {quote.status === "draft" && (
          <button
            onClick={handleSend}
            disabled={submitting}
            className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            Send to client
          </button>
        )}
      </div>

      <div className="bg-gray-50 rounded-lg p-4 mb-6 grid grid-cols-2 gap-4 text-sm">
        <div><span className="text-gray-500">Sailing date</span><p>{quote.sailing_date ?? "—"}</p></div>
        <div><span className="text-gray-500">Duration</span><p>{quote.duration_nights ? `${quote.duration_nights} nights` : "—"}</p></div>
        <div><span className="text-gray-500">Cabin</span><p>{quote.cabin_category ?? "—"}</p></div>
        <div><span className="text-gray-500">Passengers</span><p>{quote.passenger_count ?? "—"}</p></div>
        <div><span className="text-gray-500">Commissionable fare</span><p>{quote.commissionable_fare != null ? `$${quote.commissionable_fare.toFixed(2)}` : "—"}</p></div>
        <div><span className="text-gray-500">Total</span><p>{quote.total_amount != null ? `$${quote.total_amount.toFixed(2)}` : "—"}</p></div>
      </div>

      <div className="mb-6">
        <h2 className="text-sm font-medium text-gray-500 mb-2">Line items (commissionable status)</h2>
        <ul className="space-y-1 text-sm">
          {COMMISSIONABLE_LINE_ITEMS.map((item) => (
            <li key={item.key} className="flex justify-between text-gray-700">
              <span>{item.label}</span>
              <span className="text-gray-400 capitalize">{item.status.replace(/_/g, " ")}</span>
            </li>
          ))}
        </ul>
      </div>

      {quote.custom_notes && (
        <div className="border-t border-gray-200 pt-4 text-sm text-gray-600">
          <p className="font-medium text-gray-500 mb-1">Notes</p>
          <p>{quote.custom_notes}</p>
        </div>
      )}
    </div>
  );
}
