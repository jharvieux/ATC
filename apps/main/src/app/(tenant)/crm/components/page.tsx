"use client";

// BP40 §40.5.3 — Components bulk view across all bookings.

import { useCallback, useEffect, useState } from "react";
import { formatCents } from "@/lib/money";

type Item = {
  id: string;
  booking_id: string;
  item_type: string;
  description: string;
  supplier_name: string | null;
  status: string;
  start_date: string | null;
  customer_cost_cents: number;
  expected_commission_cents: number | null;
  commissionable: boolean;
};

export default function ComponentsBulkPage(): JSX.Element {
  const [items, setItems] = useState<Item[]>([]);
  const [type, setType] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [supplier, setSupplier] = useState<string>("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const sp = new URLSearchParams();
    if (type) sp.set("item_type", type);
    if (status) sp.set("status", status);
    if (supplier) sp.set("supplier_name", supplier);
    if (from) sp.set("start_from", from);
    if (to) sp.set("start_to", to);
    try {
      const r = await fetch(`/api/line-items?${sp.toString()}`);
      if (!r.ok) return;
      const data = (await r.json()) as { items: Item[] };
      setItems(data.items ?? []);
    } finally {
      setLoading(false);
    }
  }, [type, status, supplier, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-semibold mb-2">Components</h1>
      <p className="text-sm text-gray-500 mb-4">
        All non-cruise trip components across bookings. Useful for commission planning and supplier tracking.
      </p>

      <div className="flex flex-wrap gap-2 mb-4">
        <select value={type} onChange={(e) => setType(e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-sm">
          <option value="">All types</option>
          <option value="flight">Flight</option>
          <option value="hotel">Hotel</option>
          <option value="transfer">Transfer</option>
          <option value="excursion">Excursion</option>
          <option value="insurance">Insurance</option>
          <option value="other">Other</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-sm">
          <option value="">All statuses</option>
          <option value="planned">Planned</option>
          <option value="booked">Booked</option>
          <option value="confirmed">Confirmed</option>
          <option value="cancelled">Cancelled</option>
          <option value="completed">Completed</option>
        </select>
        <input
          type="text"
          placeholder="Supplier…"
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
          className="border border-gray-300 rounded px-2 py-1 text-sm"
        />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-sm" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="border border-gray-300 rounded px-2 py-1 text-sm" />
      </div>

      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-3">Type</th>
                <th className="text-left px-4 py-3">Description</th>
                <th className="text-left px-4 py-3">Supplier</th>
                <th className="text-left px-4 py-3">Start</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-right px-4 py-3">Cost</th>
                <th className="text-right px-4 py-3">Comm.</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id} className="border-t border-gray-100">
                  <td className="px-4 py-3 capitalize">{it.item_type}</td>
                  <td className="px-4 py-3">
                    <a href={`/crm/bookings/${it.booking_id}`} className="text-blue-600 hover:underline">
                      {it.description}
                    </a>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{it.supplier_name ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{it.start_date ?? "—"}</td>
                  <td className="px-4 py-3 text-gray-600">{it.status}</td>
                  <td className="px-4 py-3 text-right">{formatCents(it.customer_cost_cents)}</td>
                  <td className="px-4 py-3 text-right text-green-700">
                    {it.commissionable ? formatCents(it.expected_commission_cents) : "—"}
                  </td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                    No components match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
