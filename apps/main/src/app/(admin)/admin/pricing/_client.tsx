"use client";

// EPIC #1336 Phase 3 — platform-admin subscription pricing screen.
// Editing a base/seat price pushes a new Stripe Price and updates the DB.
// Editing the seat ladder is DB-only (display + abuse-revenue math).

import { useState, useEffect, useCallback } from "react";
import { adminFetch } from "@/lib/admin-fetch";

interface TierRow {
  code: string;
  base_price_monthly_cents: number;
  base_price_annual_cents: number;
}
interface PriceMapRow {
  tenant_type: string;
  tier: string;
  billing_period: string;
  line_item: string;
  stripe_price_id: string;
  amount_cents: number | null;
  currency: string;
}
interface LadderBand {
  up_to_seat: number;
  monthly_cents: number;
  annual_cents: number;
  sort_order: number;
}
interface PricingData {
  tiers: TierRow[];
  price_map: PriceMapRow[];
  seat_ladder: LadderBand[];
  stripe_configured: boolean;
}

// tenant_type+tier → tier_definitions.code (mirrors lib/stripe/tier-codes.ts).
const TIER_CODE: Record<string, Record<string, string>> = {
  byo_host: { starter: "byo_research", pro: "byo_professional", agency: "byo_agency" },
  sub_host: { starter: "sub_starter", pro: "sub_pro", agency: "sub_agency" },
};
const TENANT_LABEL: Record<string, string> = { sub_host: "Subscription Host", byo_host: "BYO Host" };
const LINE_LABEL: Record<string, string> = { base: "Base", additional_seats: "Additional seat" };
const OPEN_SENTINEL = 2147483647;

const dollars = (cents: number | null | undefined) =>
  cents == null ? "" : (cents / 100).toFixed(2);
const toCents = (d: string): number | null => {
  const n = Number.parseFloat(d);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
};
const rowKey = (r: { tenant_type: string; tier: string; billing_period: string; line_item: string }) =>
  `${r.tenant_type}.${r.tier}.${r.billing_period}.${r.line_item}`;

export default function AdminPricingPage() {
  const [data, setData] = useState<PricingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [ladderDraft, setLadderDraft] = useState<LadderBand[]>([]);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  // Best-known current amount for a price-map row: the stored Stripe amount, or
  // the tier_definitions base price (Stripe's amount isn't fetched on read).
  const knownCents = useCallback(
    (r: PriceMapRow, tiers: TierRow[]): number | null => {
      if (r.amount_cents != null) return r.amount_cents;
      if (r.line_item === "base") {
        const code = TIER_CODE[r.tenant_type]?.[r.tier];
        const td = tiers.find((t) => t.code === code);
        if (td) return r.billing_period === "annual" ? td.base_price_annual_cents : td.base_price_monthly_cents;
      }
      return null;
    },
    [],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminFetch("/api/admin/pricing");
      if (!res.ok) throw new Error("Failed to load pricing.");
      const d = (await res.json()) as PricingData;
      setData(d);
      const nextDrafts: Record<string, string> = {};
      for (const r of d.price_map) nextDrafts[rowKey(r)] = dollars(knownCents(r, d.tiers));
      setDrafts(nextDrafts);
      setLadderDraft(d.seat_ladder.map((b) => ({ ...b })));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [knownCents]);

  useEffect(() => {
    void load();
  }, [load]);

  async function savePrice(r: PriceMapRow) {
    const key = rowKey(r);
    const cents = toCents(drafts[key] ?? "");
    if (cents == null) {
      setError(`Enter a valid amount for ${key}.`);
      return;
    }
    setSavingKey(key);
    setError(null);
    setMsg(null);
    try {
      const res = await adminFetch("/api/admin/pricing", {
        method: "PUT",
        body: JSON.stringify({
          kind: "stripe_price",
          tenant_type: r.tenant_type,
          tier: r.tier,
          billing_period: r.billing_period,
          line_item: r.line_item,
          amount_cents: cents,
        }),
      });
      const body = (await res.json()) as { error?: string; message?: string; unchanged?: boolean };
      if (!res.ok) throw new Error(body.message ?? body.error ?? "Save failed.");
      setMsg(body.unchanged ? `${key}: unchanged (already at this amount).` : `${key}: new Stripe Price created.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSavingKey(null);
    }
  }

  async function saveLadder() {
    setSavingKey("seat_ladder");
    setError(null);
    setMsg(null);
    try {
      const res = await adminFetch("/api/admin/pricing", {
        method: "PUT",
        body: JSON.stringify({ kind: "seat_ladder", bands: ladderDraft }),
      });
      const body = (await res.json()) as { error?: string; message?: string; band_count?: number };
      if (!res.ok) throw new Error(body.message ?? body.error ?? "Save failed.");
      setMsg(`Seat ladder saved (${body.band_count} bands).`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setSavingKey(null);
    }
  }

  if (loading) return <div className="max-w-5xl mx-auto py-8 px-4 text-gray-500 text-sm">Loading…</div>;
  if (!data) return <div className="max-w-5xl mx-auto py-8 px-4 text-red-700 text-sm">{error ?? "No data."}</div>;

  const baseRows = data.price_map.filter((r) => r.line_item === "base");
  const seatRows = data.price_map.filter((r) => r.line_item === "additional_seats");

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <h1 className="text-2xl font-bold mb-2">Subscription Pricing</h1>
      <p className="text-sm text-gray-600 mb-6">
        Editing a price creates a new Stripe Price and repoints the product default. Existing subscriptions keep their
        current price; new prices apply to new checkouts only. Changes propagate to all readers within ~60 seconds.
      </p>

      {!data.stripe_configured && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded p-3 mb-4">
          STRIPE_SECRET_KEY is not configured in this environment — price edits will fail until it is set.
        </div>
      )}
      {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-3 mb-4">{error}</div>}
      {msg && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded p-3 mb-4">{msg}</div>}

      <PriceTable title="Tier base prices" rows={baseRows} drafts={drafts} setDrafts={setDrafts} savingKey={savingKey} onSave={savePrice} />
      <PriceTable title="Additional-seat prices" rows={seatRows} drafts={drafts} setDrafts={setDrafts} savingKey={savingKey} onSave={savePrice} />

      <div className="mt-8">
        <h2 className="text-lg font-semibold mb-1">Agency seat ladder</h2>
        <p className="text-sm text-gray-600 mb-3">
          Graduated per-seat pricing used for display and abuse-revenue math (not billed directly by Stripe). The final
          band must stay open-ended (max seat = {OPEN_SENTINEL}).
        </p>
        <table className="w-full text-sm border-collapse mb-3">
          <thead>
            <tr className="bg-gray-50 text-left">
              <th className="border px-3 py-2">Band</th>
              <th className="border px-3 py-2">Up to seat</th>
              <th className="border px-3 py-2">Monthly ($)</th>
              <th className="border px-3 py-2">Annual ($)</th>
            </tr>
          </thead>
          <tbody>
            {ladderDraft.map((b, i) => (
              <tr key={b.sort_order}>
                <td className="border px-3 py-2">{b.sort_order}</td>
                <td className="border px-3 py-2">
                  {b.up_to_seat === OPEN_SENTINEL ? (
                    <span className="text-gray-500">and up</span>
                  ) : (
                    <input
                      type="number"
                      min={2}
                      value={b.up_to_seat}
                      onChange={(e) => {
                        const v = Number.parseInt(e.target.value, 10);
                        setLadderDraft((d) => d.map((x, j) => (j === i ? { ...x, up_to_seat: v } : x)));
                      }}
                      className="w-24 border rounded px-2 py-1 text-sm"
                    />
                  )}
                </td>
                <td className="border px-3 py-2">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={dollars(b.monthly_cents)}
                    onChange={(e) => {
                      const c = toCents(e.target.value) ?? 0;
                      setLadderDraft((d) => d.map((x, j) => (j === i ? { ...x, monthly_cents: c } : x)));
                    }}
                    className="w-28 border rounded px-2 py-1 text-sm"
                  />
                </td>
                <td className="border px-3 py-2">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={dollars(b.annual_cents)}
                    onChange={(e) => {
                      const c = toCents(e.target.value) ?? 0;
                      setLadderDraft((d) => d.map((x, j) => (j === i ? { ...x, annual_cents: c } : x)));
                    }}
                    className="w-28 border rounded px-2 py-1 text-sm"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          type="button"
          onClick={saveLadder}
          disabled={savingKey === "seat_ladder"}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-sm"
        >
          {savingKey === "seat_ladder" ? "Saving…" : "Save seat ladder"}
        </button>
      </div>
    </div>
  );
}

function PriceTable({
  title,
  rows,
  drafts,
  setDrafts,
  savingKey,
  onSave,
}: {
  title: string;
  rows: PriceMapRow[];
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  savingKey: string | null;
  onSave: (r: PriceMapRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-8">
      <h2 className="text-lg font-semibold mb-3">{title}</h2>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-gray-50 text-left">
            <th className="border px-3 py-2">Tenant type</th>
            <th className="border px-3 py-2">Tier</th>
            <th className="border px-3 py-2">Period</th>
            <th className="border px-3 py-2">Amount ($)</th>
            <th className="border px-3 py-2">Stripe Price ID</th>
            <th className="border px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const key = rowKey(r);
            return (
              <tr key={key}>
                <td className="border px-3 py-2">{TENANT_LABEL[r.tenant_type] ?? r.tenant_type}</td>
                <td className="border px-3 py-2 capitalize">
                  {r.tier}
                  {r.line_item !== "base" ? ` · ${LINE_LABEL[r.line_item]}` : ""}
                </td>
                <td className="border px-3 py-2 capitalize">{r.billing_period}</td>
                <td className="border px-3 py-2">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={drafts[key] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                    className="w-28 border rounded px-2 py-1 text-sm"
                  />
                </td>
                <td className="border px-3 py-2 font-mono text-xs text-gray-500">{r.stripe_price_id || "—"}</td>
                <td className="border px-3 py-2">
                  <button
                    type="button"
                    onClick={() => onSave(r)}
                    disabled={savingKey === key}
                    className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-xs"
                  >
                    {savingKey === key ? "Saving…" : "Save"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
