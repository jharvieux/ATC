"use client";

// §15.15 — Subscription management console.
// Visible to tenant_billing_admin role. Read-only if pending_review or suspended.

import { useState, useEffect } from "react";

type BillingData = {
  tenant: {
    tier_id: string | null;
    seat_count: number;
    billing_period: string;
    status: string;
    stripe_subscription_id: string | null;
    pending_billing_period_change_effective_at: string | null;
  };
  invoices: {
    id: string;
    amount_due: number;
    amount_paid: number;
    currency: string;
    status: string;
    period_start: number;
    period_end: number;
    hosted_invoice_url: string | null;
  }[];
  read_only: boolean;
};

export default function BillingPage() {
  const [data, setData] = useState<BillingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Seat count editor
  const [newSeats, setNewSeats] = useState<number | null>(null);

  async function loadBilling() {
    const res = await fetch("/api/tenant/billing");
    const d = await res.json();
    setData(d);
    setNewSeats(d.tenant?.seat_count ?? 1);
    setLoading(false);
  }

  useEffect(() => { loadBilling(); }, []);

  async function handleAction(action: string, extra: Record<string, unknown> = {}) {
    setSubmitting(true);
    setActionError(null);

    const res = await fetch("/api/tenant/billing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...extra }),
    });

    const d = await res.json();
    if (!res.ok) {
      setActionError(d.error ?? "Action failed");
      setSubmitting(false);
      return;
    }

    await loadBilling();
    setSubmitting(false);
  }

  if (loading) return <div className="p-8">Loading…</div>;
  if (!data) return <div className="p-8 text-red-600">Failed to load billing data.</div>;

  const { tenant, invoices, read_only } = data;
  const isAgency = true; // TODO(bp23-tier-lookup): derive from tier_id → tier_definitions lookup

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-8">
      <h1 className="text-2xl font-semibold">Billing &amp; Subscription</h1>

      {read_only && (
        <div className="border border-amber-400 bg-amber-50 rounded p-4 text-sm text-amber-800">
          Your account is in a restricted state. Billing changes are read-only.
        </div>
      )}

      {/* Current plan summary */}
      <section className="border rounded p-4 space-y-2">
        <h2 className="font-medium">Current Plan</h2>
        <dl className="text-sm space-y-1">
          <div><dt className="inline font-medium">Billing period:</dt> <dd className="inline capitalize">{tenant.billing_period}</dd></div>
          <div><dt className="inline font-medium">Seats:</dt> <dd className="inline">{tenant.seat_count}</dd></div>
          {tenant.pending_billing_period_change_effective_at && (
            <div className="text-amber-600">
              Switching to monthly effective {new Date(tenant.pending_billing_period_change_effective_at).toLocaleDateString()}
            </div>
          )}
        </dl>
      </section>

      {/* Seat management — Agency only */}
      {isAgency && !read_only && (
        <section className="border rounded p-4">
          <h2 className="font-medium mb-3">Manage Seats</h2>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={1}
              value={newSeats ?? 1}
              onChange={(e) => setNewSeats(Math.max(1, parseInt(e.target.value, 10) || 1))}
              className="w-24 border rounded px-3 py-2"
            />
            <button
              onClick={() => handleAction("update_seats", { seat_count: newSeats })}
              disabled={submitting || newSeats === tenant.seat_count}
              className="bg-blue-600 text-white px-4 py-2 rounded text-sm disabled:opacity-50"
            >
              Update Seats
            </button>
          </div>
        </section>
      )}

      {/* Billing period switch */}
      {!read_only && (
        <section className="border rounded p-4">
          <h2 className="font-medium mb-3">Billing Period</h2>
          {tenant.billing_period === "monthly" ? (
            <button
              onClick={() => handleAction("switch_billing_period", { billing_period: "annual" })}
              disabled={submitting}
              className="text-sm bg-blue-600 text-white px-4 py-2 rounded disabled:opacity-50"
            >
              Switch to Annual (Save 2 months)
            </button>
          ) : (
            <button
              onClick={() => handleAction("switch_billing_period", { billing_period: "monthly" })}
              disabled={submitting}
              className="text-sm border px-4 py-2 rounded disabled:opacity-50"
            >
              Switch to Monthly (effective at renewal)
            </button>
          )}
        </section>
      )}

      {actionError && <p className="text-red-600 text-sm">{actionError}</p>}

      {/* Invoice history */}
      <section>
        <h2 className="font-medium mb-3">Invoice History</h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-gray-500">No invoices yet.</p>
        ) : (
          <div className="space-y-2">
            {invoices.map((inv) => (
              <div key={inv.id} className="border rounded p-3 flex items-center justify-between text-sm">
                <div>
                  <p>{new Date(inv.period_start * 1000).toLocaleDateString()} – {new Date(inv.period_end * 1000).toLocaleDateString()}</p>
                  <p className="text-xs text-gray-500 capitalize">{inv.status}</p>
                </div>
                <div className="text-right">
                  <p>${(inv.amount_due / 100).toFixed(2)}</p>
                  {inv.hosted_invoice_url && (
                    <a href={inv.hosted_invoice_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 underline">View</a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
