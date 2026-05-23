// §26.9 — Operator-facing vendor status page.
// Reads the in-memory registry. Per-instance snapshot — if the operator
// hits this page multiple times they may see slightly different states
// from different Vercel function instances during a partial outage.

import { snapshotVendorHealth } from "@/lib/vendor-health/registry";

export const dynamic = "force-dynamic";

export default function VendorStatusPage(): JSX.Element {
  const snapshot = snapshotVendorHealth();
  const rows = Object.entries(snapshot);

  return (
    <main style={{ padding: 24, maxWidth: 880, margin: "0 auto" }}>
      <h1>Vendor status (this instance)</h1>
      <p style={{ color: "#555" }}>
        Updated by the <code>vendor-health-probe</code> cron every minute. This
        is a per-instance view — open the page multiple times to compare
        across instances.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
        <thead>
          <tr style={{ background: "#f3f4f6" }}>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Vendor</th>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Status</th>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Failures</th>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Last checked</th>
            <th style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #e5e7eb" }}>Last error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, state]) => (
            <tr key={name}>
              <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6", fontWeight: 600 }}>{name}</td>
              <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6", color: statusColor(state.status) }}>
                {state.status}
              </td>
              <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>{state.consecutive_failures}</td>
              <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>
                {state.last_checked_at ?? "—"}
              </td>
              <td style={{ padding: 10, borderBottom: "1px solid #f3f4f6", color: "#dc2626" }}>
                {state.last_error ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

function statusColor(s: string): string {
  if (s === "healthy") return "#16a34a";
  if (s === "degraded") return "#ca8a04";
  return "#dc2626";
}
