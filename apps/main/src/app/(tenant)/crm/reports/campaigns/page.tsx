"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ReportShell } from "@/components/reports/ReportShell";

type Item = {
  utm_campaign: string;
  display_name: string | null;
  campaign_cost_cents: number | null;
  currency: string | null;
  leads: number;
  bookings: number;
  gross_commission_cents: number;
  net_commission_cents: number;
  cost_per_lead_cents: number | null;
};

function dollars(cents: number | null): string {
  if (cents === null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function CampaignsPage(): JSX.Element {
  const search = useSearchParams();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const sp = new URLSearchParams(search);
    try {
      const r = await fetch(`/api/reports/campaigns?${sp.toString()}`);
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
      title="Campaign performance"
      description="Per-campaign leads, bookings, commission, and cost-per-lead when cost is set."
      api_path="/api/reports/campaigns"
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
                <th className="text-left px-4 py-3">Campaign</th>
                <th className="text-right px-4 py-3">Cost</th>
                <th className="text-right px-4 py-3">Leads</th>
                <th className="text-right px-4 py-3">Bookings</th>
                <th className="text-right px-4 py-3">Gross</th>
                <th className="text-right px-4 py-3">CPL</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.utm_campaign} className="border-t border-gray-100">
                  <td className="px-4 py-3">
                    <div className="font-medium">{it.display_name ?? it.utm_campaign}</div>
                    {it.display_name && (
                      <div className="text-xs text-gray-500">{it.utm_campaign}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">{dollars(it.campaign_cost_cents)}</td>
                  <td className="px-4 py-3 text-right">{it.leads}</td>
                  <td className="px-4 py-3 text-right font-medium">{it.bookings}</td>
                  <td className="px-4 py-3 text-right">{dollars(it.gross_commission_cents)}</td>
                  <td className="px-4 py-3 text-right text-gray-600">
                    {it.cost_per_lead_cents === null ? (
                      <span className="text-xs text-amber-700">Set cost to see CPL</span>
                    ) : (
                      dollars(it.cost_per_lead_cents)
                    )}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                    No campaign data in this window.
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
