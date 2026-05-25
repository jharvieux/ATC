"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ReportShell } from "@/components/reports/ReportShell";

type Item = {
  channel: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  bookings: number;
  gross_commission_cents: number;
  net_commission_cents: number;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function BookingsBySourcePage(): JSX.Element {
  const search = useSearchParams();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const sp = new URLSearchParams(search);
    try {
      const r = await fetch(`/api/reports/bookings-by-source?${sp.toString()}`);
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
      title="Bookings by source"
      description="Confirmed bookings + commission grouped by conversion-touch channel."
      api_path="/api/reports/bookings-by-source"
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
                <th className="text-left px-4 py-3">UTM source</th>
                <th className="text-left px-4 py-3">Campaign</th>
                <th className="text-right px-4 py-3">Bookings</th>
                <th className="text-right px-4 py-3">Gross</th>
                <th className="text-right px-4 py-3">Net</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-4 py-3">{it.channel ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{it.utm_source ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{it.utm_campaign ?? "—"}</td>
                  <td className="px-4 py-3 text-right font-medium">{it.bookings}</td>
                  <td className="px-4 py-3 text-right">{dollars(it.gross_commission_cents)}</td>
                  <td className="px-4 py-3 text-right">{dollars(it.net_commission_cents)}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                    No bookings in this window.
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
