"use client";

// §12.4 / §38 — Quote list. Each row shows its representative option's trip
// summary (customer-selected option, else lowest option_index), served by
// GET /api/quotes. Money is in cents on the wire; formatted to dollars here.

import Link from "next/link";
import { useState, useEffect } from "react";
import { formatCents } from "@/lib/money";

interface QuoteListItem {
  id: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  total_amount_cents: number | null;
  status: string;
  created_at: string;
}

export function QuotesView() {
  const [quotes, setQuotes] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/quotes")
      .then(async (res) => {
        if (!res.ok) { setError("Failed to load quotes"); return; }
        const data: { quotes: QuoteListItem[] } = await res.json();
        setQuotes(data.quotes ?? []);
      })
      .catch(() => setError("Failed to load quotes"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Quotes</h1>
        <Link
          href="/crm/quotes/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
        >
          New quote
        </Link>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : error ? (
        <div className="text-red-600 text-sm">{error}</div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-3">Cruise / Ship</th>
                <th className="text-left px-4 py-3">Sailing date</th>
                <th className="text-left px-4 py-3">Total</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {quotes.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                    No quotes yet.
                  </td>
                </tr>
              ) : (
                quotes.map((q) => (
                  <tr key={q.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link href={`/crm/quotes/${q.id}`} className="text-blue-600 hover:underline">
                        {q.cruise_line ?? "Quote"}{q.ship_name ? ` — ${q.ship_name}` : ""}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-gray-700">{q.sailing_date ?? "—"}</td>
                    <td className="px-4 py-3 text-gray-700">{formatCents(q.total_amount_cents)}</td>
                    <td className="px-4 py-3 text-gray-700 capitalize">{q.status}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(q.created_at).toLocaleDateString("en-US")}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
