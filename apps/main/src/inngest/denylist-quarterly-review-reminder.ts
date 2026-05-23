// §24.5 / §26.11 — Quarterly reminder to review the platform deny-list.
//
// Fires every 90 days. Without active maintenance, the list ages out. This
// cron alerts the platform admin both via the audit_log (BP26) and via a
// console.warn breadcrumb for operators tailing logs.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { writeAuditLog } from "@/lib/audit/write";

export const denylistQuarterlyReviewReminder = inngest.createFunction(
  {
    id: "denylist-quarterly-review-reminder",
    // Every 90 days: pick a deterministic date — first of every third month
    // at 10:00 UTC: Jan/Apr/Jul/Oct.
    triggers: [{ cron: "0 10 1 1,4,7,10 *" }],
  },
  async () => {
    const svc = createServiceRoleClient();
    const { data } = await svc
      .from("platform_settings")
      .select("value")
      .eq("key", "supervisor_slur_deny_list")
      .maybeSingle();
    const list = (data as { value?: unknown } | null)?.value;
    const count = Array.isArray(list) ? list.length : 0;
    await writeAuditLog({
      actor_type: "system",
      action: "denylist.quarterly_review_due",
      resource_type: "platform_settings",
      changes: { current_count: count, docs: "/admin/denylist" },
    });
    console.warn(
      "[denylist-quarterly-review-reminder] " +
        JSON.stringify({
          message: "Platform deny-list quarterly review due.",
          current_count: count,
          docs: "/admin/denylist",
          spec: "§24.5 / §26.11",
        }),
    );
    return { current_count: count };
  },
);
