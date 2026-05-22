"use client";

// §15.11 — Platform admin review queue for pending tenant applications.
// Visible only to platform_compliance and platform_super_admin roles.

import { useState, useEffect } from "react";

type TenantSummary = {
  id: string;
  slug: string;
  display_name: string;
  legal_name: string;
  tenant_type: string;
  state_of_operation: string | null;
  seat_count: number;
  billing_period: string;
  review_decision: string;
  created_at: string;
};

const ONBOARDING_STAGES = [
  "signup","profile","legal","ica","tax_form","state_of_operation",
  "tier_select","subscription","connect_setup","branding","review_submitted",
] as const;

export default function ReviewQueuePage() {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<TenantSummary | null>(null);
  const [action, setAction] = useState<"approve" | "reject" | "request_more_info" | null>(null);
  const [reason, setReason] = useState("");
  const [revertStage, setRevertStage] = useState<string>("profile");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/tenants/review-queue", {
      headers: { "x-admin-user-id": "current" }, // TODO(rbac): use actual admin session
    })
      .then((r) => r.json())
      .then((d) => { setTenants(d.tenants ?? []); setLoading(false); });
  }, []);

  async function submitAction() {
    if (!selected || !action) return;
    setSubmitting(true);
    setError(null);

    const body: Record<string, unknown> = { action, reason };
    if (action === "request_more_info") body.revert_to_stage = revertStage;

    const res = await fetch(`/api/admin/tenants/${selected.id}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-user-id": "current" },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Action failed");
      setSubmitting(false);
      return;
    }

    setTenants((prev) => prev.filter((t) => t.id !== selected.id));
    setSelected(null);
    setAction(null);
    setReason("");
    setSubmitting(false);
  }

  if (loading) return <div className="p-8">Loading…</div>;

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">Tenant Review Queue ({tenants.length})</h1>

      {tenants.length === 0 && (
        <p className="text-gray-500">No pending applications.</p>
      )}

      <div className="space-y-3">
        {tenants.map((t) => (
          <div key={t.id} className="border rounded p-4 flex items-center justify-between">
            <div>
              <p className="font-medium">{t.display_name}</p>
              <p className="text-xs text-gray-500">{t.legal_name} · {t.slug} · {t.state_of_operation ?? "—"} · Submitted {new Date(t.created_at).toLocaleDateString()}</p>
            </div>
            <button
              onClick={() => { setSelected(t); setAction(null); setReason(""); }}
              className="text-sm bg-blue-600 text-white px-3 py-1 rounded"
            >
              Review
            </button>
          </div>
        ))}
      </div>

      {/* Review modal */}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg w-full max-w-md p-6">
            <h2 className="font-semibold text-lg mb-4">Review: {selected.display_name}</h2>
            <dl className="text-sm space-y-1 mb-4">
              <div><dt className="inline font-medium">Legal name:</dt> <dd className="inline">{selected.legal_name}</dd></div>
              <div><dt className="inline font-medium">Type:</dt> <dd className="inline">{selected.tenant_type}</dd></div>
              <div><dt className="inline font-medium">State:</dt> <dd className="inline">{selected.state_of_operation ?? "—"}</dd></div>
              <div><dt className="inline font-medium">Plan:</dt> <dd className="inline">{selected.billing_period} · {selected.seat_count} seat{selected.seat_count !== 1 ? "s" : ""}</dd></div>
            </dl>

            {!action && (
              <div className="flex gap-2">
                <button onClick={() => setAction("approve")} className="flex-1 bg-green-600 text-white rounded py-2 text-sm">Approve</button>
                <button onClick={() => setAction("reject")} className="flex-1 bg-red-600 text-white rounded py-2 text-sm">Reject</button>
                <button onClick={() => setAction("request_more_info")} className="flex-1 bg-amber-500 text-white rounded py-2 text-sm">More Info</button>
              </div>
            )}

            {action && (
              <div className="space-y-3 mt-4">
                <p className="text-sm font-medium capitalize">{action.replace(/_/g, " ")}</p>
                <textarea
                  className="w-full border rounded p-2 text-sm"
                  rows={3}
                  placeholder="Reason / notes (optional for approve, recommended for others)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                {action === "request_more_info" && (
                  <div>
                    <label className="text-sm font-medium block mb-1">Revert to stage:</label>
                    <select className="border rounded px-2 py-1 text-sm w-full" value={revertStage} onChange={(e) => setRevertStage(e.target.value)}>
                      {ONBOARDING_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                )}
                {error && <p className="text-red-600 text-sm">{error}</p>}
                <div className="flex gap-2">
                  <button onClick={submitAction} disabled={submitting} className="flex-1 bg-blue-600 text-white rounded py-2 text-sm disabled:opacity-50">
                    {submitting ? "Submitting…" : "Confirm"}
                  </button>
                  <button onClick={() => setAction(null)} className="flex-1 border rounded py-2 text-sm">
                    Back
                  </button>
                </div>
              </div>
            )}

            <button onClick={() => { setSelected(null); setAction(null); }} className="mt-3 text-xs text-gray-400 w-full">
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
