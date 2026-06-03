"use client";

// §12.4 / §38 — Quote detail with line-item editor.
//
// §38: the quote is a container; trip detail + per-option money live on
// quote_options. GET /api/quotes/[id] returns the container plus its
// representative option (customer-selected, else lowest option_index). Money
// is in cents on the wire; formatted to dollars here.
//
// PDF download is served by GET /api/quotes/[id]/pdf, which streams the
// same binary that /send attaches to the customer email (renderQuotePdf
// fed by the shared loadQuoteRenderInput helper).

import { useState, useEffect, use } from "react";
import { COMMISSIONABLE_LINE_ITEMS } from "@/lib/commissions/commissionable-line-items";
import { QuoteCopilotPanel } from "@/components/quote/QuoteCopilotPanel";

interface QuoteOption {
  option_index: number;
  customer_selected: boolean | null;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  passenger_count: number | null;
  commissionable_fare_cents: number | null;
  non_commissionable_total_cents: number | null;
  total_amount_cents: number | null;
  currency: string | null;
}

interface QuoteDetail {
  id: string;
  contact_id: string;
  status: string;
  custom_notes: string | null;
  show_breakdown_to_customer: boolean;
  created_at: string;
  option: QuoteOption | null;
  option_count: number;
}

function formatMoneyCents(cents: number | null): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/quotes/${id}`)
      .then(async (res) => {
        if (!res.ok) { setError("Quote not found"); return; }
        const data: QuoteDetail = await res.json();
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
      // /send returns the container row (no trip fields); only the status
      // changes, so patch that and leave the loaded option in place.
      const data: { quote?: { status?: string } } = await res.json();
      setQuote((q) => (q ? { ...q, status: data.quote?.status ?? "sent" } : q));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="p-8 text-center">Loading…</div>;
  if (error || !quote) return <div className="p-8 text-center text-red-600">{error ?? "Not found"}</div>;

  const option = quote.option;

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">
            {option?.cruise_line ?? "Quote"}{option?.ship_name ? ` — ${option.ship_name}` : ""}
          </h1>
          <span className="text-sm text-gray-500 capitalize">{quote.status}</span>
          {quote.option_count > 1 && (
            <span className="ml-2 text-xs text-gray-400">
              {quote.option_count} options
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/quotes/${id}/pdf`}
            className="bg-white text-gray-700 px-4 py-2 rounded-md text-sm font-medium border border-gray-300 hover:bg-gray-50"
          >
            Download PDF
          </a>
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
      </div>

      <div className="bg-gray-50 rounded-lg p-4 mb-6 grid grid-cols-2 gap-4 text-sm">
        <div><span className="text-gray-500">Sailing date</span><p>{option?.sailing_date ?? "—"}</p></div>
        <div><span className="text-gray-500">Duration</span><p>{option?.duration_nights ? `${option.duration_nights} nights` : "—"}</p></div>
        <div><span className="text-gray-500">Cabin</span><p>{option?.cabin_category ?? "—"}</p></div>
        <div><span className="text-gray-500">Passengers</span><p>{option?.passenger_count ?? "—"}</p></div>
        <div><span className="text-gray-500">Commissionable fare</span><p>{formatMoneyCents(option?.commissionable_fare_cents ?? null)}</p></div>
        <div><span className="text-gray-500">Total</span><p>{formatMoneyCents(option?.total_amount_cents ?? null)}</p></div>
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
        <div className="border-t border-gray-200 pt-4 text-sm text-gray-600 mb-6">
          <p className="font-medium text-gray-500 mb-1">Notes</p>
          <p>{quote.custom_notes}</p>
        </div>
      )}

      <QuoteCopilotPanel quote_id={quote.id} />
    </div>
  );
}
