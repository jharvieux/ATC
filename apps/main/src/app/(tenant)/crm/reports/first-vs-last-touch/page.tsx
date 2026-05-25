"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ReportShell } from "@/components/reports/ReportShell";

type Item = { first: string | null; last: string | null; count: number };

export default function FirstVsLastTouchPage(): JSX.Element {
  return (
    <Suspense fallback={<div className="text-sm text-gray-500">Loading…</div>}>
      <FirstVsLastTouchContent />
    </Suspense>
  );
}

function FirstVsLastTouchContent(): JSX.Element {
  const search = useSearchParams();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const sp = new URLSearchParams(search);
    try {
      const r = await fetch(`/api/reports/first-vs-last-touch?${sp.toString()}`);
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
      title="First-touch vs last-touch"
      description="Distribution of (acquisition channel, conversion channel) pairs. Reveals multi-touch journeys."
      api_path="/api/reports/first-vs-last-touch"
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
                <th className="text-left px-4 py-3">First-touch channel</th>
                <th className="text-left px-4 py-3">Conversion channel</th>
                <th className="text-right px-4 py-3">Bookings</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-4 py-3">{it.first ?? "—"}</td>
                  <td className="px-4 py-3">{it.last ?? "—"}</td>
                  <td className="px-4 py-3 text-right font-medium">{it.count}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-gray-400">
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
