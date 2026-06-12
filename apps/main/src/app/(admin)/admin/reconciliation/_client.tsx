"use client";

// §14.8 — Manual commission statement upload (platform admin only).
// Auth is enforced by the (admin) layout; the API route also independently
// gates with assertPlatformAdmin.

import { useState } from "react";
import { FileDropZone } from "@/components/ui/file-drop-zone";

interface ReconciliationResult {
  ok: boolean;
  parse_confidence: "high" | "medium" | "low";
  warnings: string[];
  results: {
    total: number;
    auto_accepted: number;
    queued: number;
    orphans: number;
    errors: number;
  };
}

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "High — all fields parsed cleanly",
  medium: "Medium — some fields inferred",
  low: "Low — review warnings before trusting results",
};

const CONFIDENCE_COLOR: Record<string, string> = {
  high: "text-green-700 bg-green-50 border-green-200",
  medium: "text-amber-700 bg-amber-50 border-amber-200",
  low: "text-red-700 bg-red-50 border-red-200",
};

export default function ReconciliationPage() {
  const [tenantId, setTenantId] = useState("");
  const [result, setResult] = useState<ReconciliationResult | null>(null);
  const [successCount, setSuccessCount] = useState(0);

  const tenantIdValid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    tenantId.trim(),
  );

  function handleSuccess(data: unknown) {
    const r = data as ReconciliationResult;
    setResult(r);
    setSuccessCount((n) => n + 1);
  }

  return (
    <main className="px-6 py-10 max-w-[720px] mx-auto">
      <h1 className="text-[22px] font-bold mb-1">Commission Statement Upload</h1>
      <p className="text-muted-foreground text-[14px] mb-8">
        Upload a CSV commission statement. Claude Haiku parses the line items and matches them
        against open bookings. Variances under $5 are auto-accepted; larger variances go to the
        reconciliation review queue.
      </p>

      <div className="mb-5">
        <label className="block text-sm font-medium text-gray-700 mb-1" htmlFor="tenant-id">
          Tenant ID <span className="text-red-500">*</span>
        </label>
        <input
          id="tenant-id"
          type="text"
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        {tenantId && !tenantIdValid && (
          <p className="mt-1 text-xs text-red-600">Must be a valid UUID.</p>
        )}
      </div>

      <FileDropZone
        accept="text/csv,.csv,text/plain,.txt"
        acceptLabel="CSV or plain text"
        maxBytes={500_000}
        endpoint="/api/admin/reconciliation/upload"
        {...(tenantIdValid ? { extraFields: { tenant_id: tenantId.trim() } } : {})}
        disabled={!tenantIdValid}
        onSuccess={handleSuccess}
        className="mb-6"
      />

      {!tenantIdValid && (
        <p className="text-xs text-gray-400 -mt-4 mb-6">Enter a valid tenant UUID to enable upload.</p>
      )}

      {result && (
        <div key={successCount} className="rounded-lg border border-gray-200 bg-white p-5 space-y-4">
          <h2 className="text-[15px] font-semibold">Upload complete</h2>

          <div
            className={`rounded border px-3 py-2 text-sm font-medium ${CONFIDENCE_COLOR[result.parse_confidence] ?? ""}`}
          >
            Parse confidence: {CONFIDENCE_LABEL[result.parse_confidence] ?? result.parse_confidence}
          </div>

          {result.warnings.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded px-3 py-2">
              <p className="text-xs font-semibold text-amber-800 mb-1">Parser warnings</p>
              <ul className="list-disc list-inside space-y-0.5">
                {result.warnings.map((w, i) => (
                  <li key={i} className="text-xs text-amber-700">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                { label: "Total line items", value: result.results.total, color: "text-gray-800" },
                { label: "Auto-accepted", value: result.results.auto_accepted, color: "text-green-700" },
                { label: "Queued for review", value: result.results.queued, color: "text-amber-700" },
                { label: "Orphans (no match)", value: result.results.orphans, color: "text-red-700" },
              ] as const
            ).map(({ label, value, color }) => (
              <div key={label} className="rounded border border-gray-100 bg-gray-50 px-3 py-3 text-center">
                <p className={`text-2xl font-bold ${color}`}>{value}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">{label}</p>
              </div>
            ))}
          </div>

          {result.results.errors > 0 && (
            <p className="text-sm text-red-600">
              {result.results.errors} line item{result.results.errors === 1 ? "" : "s"} failed to
              process due to server errors.
            </p>
          )}
        </div>
      )}
    </main>
  );
}
