// §23.4 — Pre-cruise email scheduler.
//
// Runs hourly. For each confirmed booking with a future sailing_date (from
// the associated groups row), checks whether the T-90/T-30/T-7/T-1 phase
// is within ±1 hour of the target and no pre_cruise_email_content row exists
// for that booking+phase yet. If so, fires precruise/email.due.

import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

const PHASES = [
  { phase: "t_90" as const, envKey: "PRECRUISE_T90_HOURS_BEFORE", defaultHours: 2160 },
  { phase: "t_30" as const, envKey: "PRECRUISE_T30_HOURS_BEFORE", defaultHours: 720  },
  { phase: "t_7"  as const, envKey: "PRECRUISE_T7_HOURS_BEFORE",  defaultHours: 168  },
  { phase: "t_1"  as const, envKey: "PRECRUISE_T1_HOURS_BEFORE",  defaultHours: 24   },
];

export const preCruiseEmailScheduler = inngest.createFunction(
  { id: "pre-cruise-email-scheduler", triggers: [{ cron: "0 * * * *" }] },
  async () => {
    const svc = createServiceRoleClient();
    const nowMs = Date.now();

    const { data: bookings, error } = await svc
      .from("bookings")
      .select("id, tenant_id, group_id, groups(sailing_date)")
      .eq("status", "confirmed")
      .not("group_id", "is", null);

    if (error) {
      console.error("[pre-cruise-scheduler] query error", error.message);
      return;
    }

    let triggered = 0;

    for (const booking of bookings ?? []) {
      const b = booking as {
        id: string;
        tenant_id: string;
        group_id: string;
        // Supabase returns related rows as an array (or null) for foreign-key joins
        groups: Array<{ sailing_date: string }> | { sailing_date: string } | null;
      };
      // Handle both array (join) and object (single) shapes
      const groupsRaw = b.groups;
      const groupRow = Array.isArray(groupsRaw) ? groupsRaw[0] : groupsRaw;
      const sailingDateStr = groupRow?.sailing_date;
      if (!sailingDateStr) continue;

      const sailingMs = new Date(sailingDateStr).getTime();
      const hoursBefore = (sailingMs - nowMs) / (1000 * 60 * 60);

      for (const { phase, envKey, defaultHours } of PHASES) {
        const targetHours = Number(process.env[envKey] ?? defaultHours);
        const diff = Math.abs(hoursBefore - targetHours);
        if (diff > 1) continue;

        const { data: existing } = await svc
          .from("pre_cruise_email_content")
          .select("id")
          .eq("booking_id", b.id)
          .eq("email_phase", phase)
          .maybeSingle();

        if (existing) continue;

        await inngest.send({
          name: "precruise/email.due",
          data: { booking_id: b.id, tenant_id: b.tenant_id, phase },
        });
        triggered++;
      }
    }

    console.log(`[pre-cruise-scheduler] triggered=${triggered}`);
  },
);
