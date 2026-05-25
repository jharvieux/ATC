"use client";

// BP38 §38.3 — Multi-option quote builder.
//
// Side-by-side editor for a quote's quote_options. Up to tier-max
// options (5 for most tiers, 1 for BYO Research). Each option has
// trip details + financials + label + pros/cons + an
// is_recommended toggle. POST /api/quotes/:id/options to add,
// PATCH /api/quote-options/:id to edit, DELETE to remove.

import { useCallback, useEffect, useState, use } from "react";

type Option = {
  id: string;
  option_index: number;
  label: string | null;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  passenger_count: number | null;
  commissionable_fare_cents: number | null;
  non_commissionable_total_cents: number | null;
  total_amount_cents: number | null;
  currency: string;
  is_recommended: boolean;
  pros: string[] | null;
  cons: string[] | null;
};

function dollars(cents: number | null): string {
  if (cents === null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function QuoteBuilderPage({ params }: { params: Promise<{ id: string }> }): JSX.Element {
  const { id } = use(params);
  const [options, setOptions] = useState<Option[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchOptions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/quotes/${id}/options`);
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? `HTTP ${r.status}`);
        return;
      }
      const data = (await r.json()) as { options: Option[] };
      setOptions(data.options ?? []);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchOptions();
  }, [fetchOptions]);

  const addOption = async () => {
    setBusy(true);
    setError(null);
    try {
      // Seed defaults from option 1 to reduce typing (per §38.3.1).
      const base = options[0];
      const body = base
        ? {
            passenger_count: base.passenger_count,
            currency: base.currency,
            duration_nights: base.duration_nights,
            cabin_category: base.cabin_category,
          }
        : {};
      const r = await fetch(`/api/quotes/${id}/options`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string; max?: number };
        setError(j.max != null ? `Max ${j.max} options reached for this tier` : j.error ?? `HTTP ${r.status}`);
        return;
      }
      await fetchOptions();
    } finally {
      setBusy(false);
    }
  };

  const removeOption = async (optionId: string) => {
    if (!confirm("Remove this option?")) return;
    setBusy(true);
    try {
      await fetch(`/api/quote-options/${optionId}`, { method: "DELETE" });
      await fetchOptions();
    } finally {
      setBusy(false);
    }
  };

  const patch = async (optionId: string, payload: Partial<Option>) => {
    const r = await fetch(`/api/quote-options/${optionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      setError(j.error ?? `HTTP ${r.status}`);
      return;
    }
    await fetchOptions();
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <a href={`/crm/quotes/${id}`} className="text-sm text-blue-600 hover:underline">
            ← Back to quote
          </a>
          <h1 className="text-2xl font-semibold mt-1">Quote options</h1>
          <p className="text-sm text-gray-500 mt-1">
            Side-by-side comparison the customer will see. Up to 5 options.
          </p>
        </div>
        <button
          onClick={() => void addOption()}
          disabled={busy}
          className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          + Add option
        </button>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 mb-4">{error}</div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : options.length === 0 ? (
        <div className="text-sm text-gray-500 border border-gray-200 rounded-lg p-6 text-center">
          No options yet. Click + Add option to start.
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {options.map((opt) => (
            <OptionCard
              key={opt.id}
              option={opt}
              onPatch={(p) => void patch(opt.id, p)}
              onRemove={() => void removeOption(opt.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function OptionCard(props: { option: Option; onPatch: (p: Partial<Option>) => void; onRemove: () => void }): JSX.Element {
  const { option, onPatch, onRemove } = props;
  return (
    <div className="border border-gray-200 rounded-lg p-4 w-72 flex-shrink-0">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-500">Option {option.option_index}</span>
        <button onClick={onRemove} className="text-xs text-red-600 hover:underline">
          Remove
        </button>
      </div>
      <input
        type="text"
        placeholder="Label (e.g. Best value)"
        value={option.label ?? ""}
        onChange={(e) => onPatch({ label: e.target.value })}
        className="w-full border border-gray-300 rounded px-2 py-1 text-sm mb-2"
      />
      <div className="space-y-1">
        <Field label="Cruise line" value={option.cruise_line ?? ""} onChange={(v) => onPatch({ cruise_line: v })} />
        <Field label="Ship" value={option.ship_name ?? ""} onChange={(v) => onPatch({ ship_name: v })} />
        <Field label="Sailing date" type="date" value={option.sailing_date ?? ""} onChange={(v) => onPatch({ sailing_date: v })} />
        <NumberField label="Nights" value={option.duration_nights} onChange={(v) => onPatch({ duration_nights: v })} />
        <Field label="Cabin" value={option.cabin_category ?? ""} onChange={(v) => onPatch({ cabin_category: v })} />
        <CentsField label="Commissionable" value={option.commissionable_fare_cents} onChange={(v) => onPatch({ commissionable_fare_cents: v })} />
        <CentsField label="Non-comm" value={option.non_commissionable_total_cents} onChange={(v) => onPatch({ non_commissionable_total_cents: v })} />
        <CentsField label="Total" value={option.total_amount_cents} onChange={(v) => onPatch({ total_amount_cents: v })} highlight />
      </div>
      <label className="flex items-center gap-2 text-xs mt-3">
        <input
          type="checkbox"
          checked={option.is_recommended}
          onChange={(e) => onPatch({ is_recommended: e.target.checked })}
        />
        Recommend this option
      </label>
      <div className="text-xs text-gray-500 mt-2">{dollars(option.total_amount_cents)}</div>
    </div>
  );
}

function Field(props: { label: string; type?: string; value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <label className="flex flex-col text-xs text-gray-600">
      <span className="mb-0.5">{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className="border border-gray-300 rounded px-2 py-1 text-sm"
      />
    </label>
  );
}

function NumberField(props: { label: string; value: number | null; onChange: (v: number | null) => void }): JSX.Element {
  return (
    <label className="flex flex-col text-xs text-gray-600">
      <span className="mb-0.5">{props.label}</span>
      <input
        type="number"
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value === "" ? null : Number(e.target.value))}
        className="border border-gray-300 rounded px-2 py-1 text-sm"
      />
    </label>
  );
}

function CentsField(props: { label: string; value: number | null; onChange: (v: number | null) => void; highlight?: boolean }): JSX.Element {
  const dollars = props.value === null ? "" : (props.value / 100).toFixed(2);
  return (
    <label className="flex flex-col text-xs text-gray-600">
      <span className="mb-0.5">{props.label} ($)</span>
      <input
        type="number"
        step="0.01"
        value={dollars}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") return props.onChange(null);
          const n = Math.round(Number(v) * 100);
          props.onChange(Number.isFinite(n) ? n : null);
        }}
        className={`border border-gray-300 rounded px-2 py-1 text-sm ${props.highlight ? "font-semibold" : ""}`}
      />
    </label>
  );
}
