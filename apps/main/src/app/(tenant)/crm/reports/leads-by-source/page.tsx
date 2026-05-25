"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ReportShell } from "@/components/reports/ReportShell";

type Item = {
  channel: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  count: number;
};

export default function LeadsBySourcePage(): JSX.Element {
  const search = useSearchParams();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const sp = new URLSearchParams(search);
    try {
      const r = await fetch(`/api/reports/leads-by-source?${sp.toString()}`);
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
      title="Leads by source"
      description="Acquired contacts grouped by first-touch channel + UTM source + campaign."
      api_path="/api/reports/leads-by-source"
    >
      {loading && <div className="text-sm text-gray-500">Loading…</div>}
      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
          {error}
        </div>
      )}
      {!loading && !error && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-3">Channel</th>
                <th className="text-left px-4 py-3">UTM source</th>
                <th className="text-left px-4 py-3">UTM campaign</th>
                <th className="text-right px-4 py-3">Leads</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-4 py-3">{it.channel ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{it.utm_source ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{it.utm_campaign ?? "—"}</td>
                  <td className="px-4 py-3 text-right font-medium">{it.count}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
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
