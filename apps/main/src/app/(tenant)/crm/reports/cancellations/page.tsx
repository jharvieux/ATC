"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ReportShell } from "@/components/reports/ReportShell";

type Item = {
  category: string;
  secondary: string | null;
  cancelled_count: number;
  lost_expected_cents: number;
  clawback_cents: number;
  net_impact_cents: number;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function CancellationsPage(): JSX.Element {
  return (
    <Suspense fallback={<div className="text-sm text-gray-500">Loading…</div>}>
      <CancellationsContent />
    </Suspense>
  );
}

function CancellationsContent(): JSX.Element {
  const router = useRouter();
  const search = useSearchParams();
  const groupBy = search.get("group_by") ?? "channel";
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const sp = new URLSearchParams(search);
    if (!sp.has("group_by")) sp.set("group_by", "channel");
    try {
      const r = await fetch(`/api/reports/cancellations?${sp.toString()}`);
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

  const onGroupChange = (v: string) => {
    const sp = new URLSearchParams(search);
    sp.set("group_by", v);
    router.push(`?${sp.toString()}`);
  };

  return (
    <ReportShell
      title="Lost revenue from cancellations"
      description="Cancelled bookings by reason + secondary drill-down. Includes §34.8 clawback amounts."
      api_path="/api/reports/cancellations"
      extra_query={{ group_by: groupBy }}
    >
      <div className="flex items-center gap-2 mb-4">
        <label className="text-sm text-gray-600">Group by</label>
        <select
          value={groupBy}
          onChange={(e) => onGroupChange(e.target.value)}
          className="border border-gray-300 rounded-md px-2 py-1 text-sm"
        >
          <option value="channel">Conversion channel</option>
          <option value="cruise_line">Cruise line</option>
          <option value="sail_quarter">Sail quarter</option>
        </select>
      </div>

      {loading && <div className="text-sm text-gray-500">Loading…</div>}
      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">{error}</div>
      )}
      {!loading && !error && (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-3">Reason category</th>
                <th className="text-left px-4 py-3">{groupBy}</th>
                <th className="text-right px-4 py-3">Count</th>
                <th className="text-right px-4 py-3">Lost expected</th>
                <th className="text-right px-4 py-3">Clawback</th>
                <th className="text-right px-4 py-3">Net impact</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-4 py-3">{it.category}</td>
                  <td className="px-4 py-3 text-gray-600">{it.secondary ?? "—"}</td>
                  <td className="px-4 py-3 text-right">{it.cancelled_count}</td>
                  <td className="px-4 py-3 text-right">{dollars(it.lost_expected_cents)}</td>
                  <td className="px-4 py-3 text-right">{dollars(it.clawback_cents)}</td>
                  <td className="px-4 py-3 text-right font-medium">{dollars(it.net_impact_cents)}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                    No cancellations in this window.
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
