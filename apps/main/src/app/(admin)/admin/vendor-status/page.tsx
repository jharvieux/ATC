// §26.9 — Operator-facing vendor status page.
// Reads the in-memory registry. Per-instance snapshot — if the operator
// hits this page multiple times they may see slightly different states
// from different Vercel function instances during a partial outage.

import { snapshotVendorHealth } from "@/lib/vendor-health/registry";
import { assertPlatformRolePage } from "@/lib/auth/assert-platform-admin";

export const dynamic = "force-dynamic";

export default async function VendorStatusPage(): Promise<JSX.Element> {
  await assertPlatformRolePage(["superadmin", "support"]);
  const snapshot = snapshotVendorHealth();
  const rows = Object.entries(snapshot);

  return (
    <main className="px-6 py-6 max-w-[880px] mx-auto">
      <h1>Vendor status (this instance)</h1>
      <p className="text-muted-foreground">
        Updated by the <code>vendor-health-probe</code> cron every minute. This
        is a per-instance view — open the page multiple times to compare
        across instances.
      </p>
      <table className="w-full border-collapse mt-4 text-sm">
        <thead>
          <tr className="bg-muted">
            <th className="text-left px-2.5 py-2.5 border-b border-border">Vendor</th>
            <th className="text-left px-2.5 py-2.5 border-b border-border">Status</th>
            <th className="text-left px-2.5 py-2.5 border-b border-border">Failures</th>
            <th className="text-left px-2.5 py-2.5 border-b border-border">Last checked</th>
            <th className="text-left px-2.5 py-2.5 border-b border-border">Last error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, state]) => (
            <tr key={name}>
              <td className="px-2.5 py-2.5 border-b border-muted font-semibold">{name}</td>
              <td className={`px-2.5 py-2.5 border-b border-muted ${statusColorClass(state.status)}`}>
                {state.status}
              </td>
              <td className="px-2.5 py-2.5 border-b border-muted">{state.consecutive_failures}</td>
              <td className="px-2.5 py-2.5 border-b border-muted">
                {state.last_checked_at ?? "—"}
              </td>
              <td className="px-2.5 py-2.5 border-b border-muted text-red-600 dark:text-red-400">
                {state.last_error ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

function statusColorClass(s: string): string {
  if (s === "healthy") return "text-green-600 dark:text-green-400";
  if (s === "degraded") return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}
