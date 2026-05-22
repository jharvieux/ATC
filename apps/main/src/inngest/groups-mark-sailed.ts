// §18.10 — Daily cron: transition active/closed groups to 'sailed' once the
// sailing_date has passed. After sailed, all surfaces are read-only.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

export const groupsMarkSailed = inngest.createFunction(
  {
    id: "groups-mark-sailed",
    triggers: [{ cron: "0 6 * * *" }], // 06:00 UTC daily
  },
  async () => {
    const svc = createServiceRoleClient();
    const today = new Date().toISOString().slice(0, 10);

    const { data, error } = await svc
      .from("groups")
      .update({ status: "sailed", sailed_at: new Date().toISOString() })
      .in("status", ["active", "closed"])
      .lt("sailing_date", today)
      .select("id");

    if (error) {
      console.error("[groups-mark-sailed] error:", error.message);
      return { sailed: 0 };
    }

    const sailed = data?.length ?? 0;
    console.log(`[groups-mark-sailed] sailed=${sailed}`);
    return { sailed };
  },
);
