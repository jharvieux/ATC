"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ReportShell } from "@/components/reports/ReportShell";

type Item = {
  channel: string | null;
  contacts: number;
  quotes: number;
  bookings: number;
  contact_to_quote_pct: number | null;
  quote_to_booking_pct: number | null;
  contact_to_booking_pct: number | null;
};

function pct(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

export default function SourceFunnelPage(): JSX.Element {
  return (
    <Suspense fallback={<div className="text-sm text-gray-500">Loading…</div>}>
      <SourceFunnelContent />
    </Suspense>
  );
}

function SourceFunnelContent(): JSX.Element {
  const search = useSearchParams();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const sp = new URLSearchParams(search);
    try {
      const r = await fetch(`/api/reports/source-funnel?${sp.toString()}`);
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${r.status}`);
        setItems([]);
        return;
      }
      const data = (await r.json()) as { items: Item[] };
      setItems(data.items ?? []);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  return (
    <ReportShell
      title="Source funnel"
      description="Contact → quote → booking conversion percentages by first-touch channel."
      api_path="/api/reports/source-funnel"
    >
      {loading && <div className="text-sm text-gray-500">Loading…</div>}
      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>
      )}
      {!loading && !error && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-3">Channel</th>
                <th className="text-right px-4 py-3">Contacts</th>
                <th className="text-right px-4 py-3">Quotes</th>
                <th className="text-right px-4 py-3">Bookings</th>
                <th className="text-right px-4 py-3">C→Q</th>
                <th className="text-right px-4 py-3">Q→B</th>
                <th className="text-right px-4 py-3">C→B</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-4 py-3">{it.channel ?? "—"}</td>
                  <td className="px-4 py-3 text-right">{it.contacts}</td>
                  <td className="px-4 py-3 text-right">{it.quotes}</td>
                  <td className="px-4 py-3 text-right font-medium">{it.bookings}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{pct(it.contact_to_quote_pct)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{pct(it.quote_to_booking_pct)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">{pct(it.contact_to_booking_pct)}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                    No data in this window.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </ReportShell>
  );
}
