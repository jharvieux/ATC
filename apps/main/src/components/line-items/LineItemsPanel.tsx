"use client";

// BP40 §40.5.1 — Booking-detail "Trip components" embed.
//
// Lists existing line items by type + "+ Add" modal with type-specific
// fields. Uses /api/bookings/:id/line-items.

import { useCallback, useEffect, useState } from "react";

type ItemType = "flight" | "hotel" | "transfer" | "excursion" | "insurance" | "other";

type LineItem = {
  id: string;
  item_type: ItemType;
  description: string;
  supplier_name: string | null;
  supplier_booking_ref: string | null;
  is_cruise_line_supplied: boolean;
  start_date: string | null;
  end_date: string | null;
  customer_cost_cents: number;
  commissionable: boolean;
  commission_rate: number | null;
  expected_commission_cents: number | null;
  status: string;
  include_in_itinerary: boolean;
};

function dollars(cents: number | null): string {
  if (cents === null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const TYPE_LABELS: Record<ItemType, string> = {
  flight: "Flight",
  hotel: "Hotel",
  transfer: "Transfer",
  excursion: "Excursion",
  insurance: "Insurance",
  other: "Other",
};

export function LineItemsPanel(props: { booking_id: string }): JSX.Element {
  const [items, setItems] = useState<LineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/bookings/${props.booking_id}/line-items`);
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as { items: LineItem[] };
      setItems(data.items ?? []);
    } finally {
      setLoading(false);
    }
  }, [props.booking_id]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (id: string) => {
    if (!confirm("Remove this component?")) return;
    await fetch(`/api/line-items/${id}`, { method: "DELETE" });
    await load();
  };

  if (loading) return <div className="text-sm text-gray-500">Loading…</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">Trip components</h3>
        <button
          onClick={() => setShowAdd(true)}
          className="text-xs text-blue-600 hover:underline"
        >
          + Add component
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2 mb-2">{error}</div>
      )}

      {items.length === 0 ? (
        <div className="text-xs text-gray-400">No components yet.</div>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-md">
          {items.map((it) => (
            <li key={it.id} className="px-3 py-2 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm">
                  <strong>{TYPE_LABELS[it.item_type]}</strong>
                  {it.start_date && <span className="text-gray-500"> · {it.start_date}</span>}
                  {it.supplier_name && <span className="text-gray-500"> · {it.supplier_name}</span>}
                </div>
                <div className="text-xs text-gray-500">{it.description}</div>
              </div>
              <div className="text-xs text-gray-600 whitespace-nowrap">
                {dollars(it.customer_cost_cents)}
                {it.commissionable && it.expected_commission_cents !== null && (
                  <span className="text-green-700 ml-2">
                    +{dollars(it.expected_commission_cents)} comm.
                  </span>
                )}
              </div>
              <button onClick={() => void remove(it.id)} className="text-xs text-red-600">×</button>
            </li>
          ))}
        </ul>
      )}

      {showAdd && (
        <AddLineItemModal
          booking_id={props.booking_id}
          onClose={() => setShowAdd(false)}
          onAdded={() => {
            setShowAdd(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function AddLineItemModal(props: {
  booking_id: string;
  onClose: () => void;
  onAdded: () => void;
}): JSX.Element {
  const [type, setType] = useState<ItemType>("flight");
  const [description, setDescription] = useState("");
  const [supplier, setSupplier] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [cost, setCost] = useState("");
  const [commissionable, setCommissionable] = useState(false);
  const [rate, setRate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!description.trim()) {
      setError("Description required");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        item_type: type,
        description,
        customer_cost_cents: cost ? Math.round(Number(cost) * 100) : 0,
        commissionable,
      };
      if (supplier) body.supplier_name = supplier;
      if (start) body.start_date = start;
      if (end) body.end_date = end;
      if (commissionable && rate) body.commission_rate = Number(rate);
      const r = await fetch(`/api/bookings/${props.booking_id}/line-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string; details?: unknown };
        setError(j.error ?? `HTTP ${r.status}`);
        return;
      }
      props.onAdded();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-md p-6">
        <h2 className="text-lg font-semibold mb-4">Add trip component</h2>

        <label className="block text-xs text-gray-600 mb-1">Type</label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as ItemType)}
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-3"
        >
          {Object.entries(TYPE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>

        <label className="block text-xs text-gray-600 mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. United UA1234 LAX → FLL"
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-3"
        />

        <label className="block text-xs text-gray-600 mb-1">Supplier (optional)</label>
        <input
          type="text"
          value={supplier}
          onChange={(e) => setSupplier(e.target.value)}
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-3"
        />

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Start date</label>
            <input
              type="date"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">End date</label>
            <input
              type="date"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
            />
          </div>
        </div>

        <label className="block text-xs text-gray-600 mb-1">Customer cost ($)</label>
        <input
          type="number"
          step="0.01"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-3"
        />

        <label className="flex items-center gap-2 text-xs mb-2">
          <input
            type="checkbox"
            checked={commissionable}
            onChange={(e) => setCommissionable(e.target.checked)}
          />
          Commissionable
        </label>
        {commissionable && (
          <>
            <label className="block text-xs text-gray-600 mb-1">Commission rate (decimal, e.g. 0.1)</label>
            <input
              type="number"
              step="0.001"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-3"
            />
          </>
        )}

        {error && <div className="text-xs text-red-600 mb-2">{error}</div>}

        <div className="flex gap-2 justify-end">
          <button onClick={props.onClose} className="text-sm px-3 py-1 rounded border border-gray-300 hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="text-sm px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
