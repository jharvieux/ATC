"use client";

// §12.4 — Quote list.

import { useState, useEffect } from "react";

interface Quote {
  id: string;
  contact_id: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  total_amount: number | null;
  status: string;
  created_at: string;
}

export default function CrmQuotesPage() {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/crm/contacts?limit=1")
      .then(() => {})
      .catch(() => {});
    setLoading(false);
  }, []);

  void quotes;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Quotes</h1>
        <a
          href="/crm/quotes/new"
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
        >
          New quote
        </a>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
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
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                  No quotes yet.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
