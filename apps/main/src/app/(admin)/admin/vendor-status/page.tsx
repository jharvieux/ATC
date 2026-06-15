// §26.9 / #786 — Operator-facing vendor status page.
// Reads from the durable `vendor_health` table for a cross-instance consistent view.

import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { listVendorHealth } from "@/lib/vendor-health/registry";
import { assertPlatformAdminAreaPage } from "@/lib/auth/assert-platform-admin";

export const dynamic = "force-dynamic";

export default async function VendorStatusPage(): Promise<JSX.Element> {
  await assertPlatformAdminAreaPage("vendor_status");
  const svc = createServiceRoleClient();
  const rows = await listVendorHealth(svc);

  return (
    <main className="px-6 py-6 max-w-[880px] mx-auto">
      <h1>Vendor status</h1>
      <p className="text-muted-foreground">
        Updated by the <code>vendor-health-probe</code> cron every 15 minutes.
        Cross-instance consistent view — reads from the shared <code>vendor_health</code> table.
      </p>
      {rows.length === 0 ? (
        <p className="mt-4 text-muted-foreground">No data yet — probe hasn&apos;t run.</p>
      ) : (
        <table className="w-full border-collapse mt-4 text-sm">
          <thead>
            <tr className="bg-muted">
              <th className="text-left px-2.5 py-2.5 border-b border-border">Vendor</th>
              <th className="text-left px-2.5 py-2.5 border-b border-border">Status</th>
              <th className="text-left px-2.5 py-2.5 border-b border-border">Failures</th>
              <th className="text-left px-2.5 py-2.5 border-b border-border">Last checked</th>
              <th className="text-left px-2.5 py-2.5 border-b border-border">Status changed</th>
              <th className="text-left px-2.5 py-2.5 border-b border-border">Last error</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.vendor}>
                <td className="px-2.5 py-2.5 border-b border-muted font-semibold">{row.vendor}</td>
                <td className={`px-2.5 py-2.5 border-b border-muted ${statusColorClass(row.status)}`}>
                  {row.status}
                </td>
                <td className="px-2.5 py-2.5 border-b border-muted">{row.consecutive_failures}</td>
                <td className="px-2.5 py-2.5 border-b border-muted">
                  {row.last_checked_at ?? "—"}
                </td>
                <td className="px-2.5 py-2.5 border-b border-muted">
                  {row.status_changed_at ?? "—"}
                </td>
                <td className="px-2.5 py-2.5 border-b border-muted text-red-600 dark:text-red-400">
                  {row.last_error ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

function statusColorClass(s: string): string {
  if (s === "healthy") return "text-green-600 dark:text-green-400";
  if (s === "degraded") return "text-yellow-600 dark:text-yellow-400";
  return "text-red-600 dark:text-red-400";
}
