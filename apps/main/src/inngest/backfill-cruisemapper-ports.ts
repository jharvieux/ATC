// §831 — On-demand port backfill for CruiseMapper sailings.
// Force-fetches every ship page regardless of content_hash so already-scheduled
// sailings get their departure/arrival ports enriched without a manual SQL hash-clear.
// Already-enriched sailings are skipped by the existing sailingDetailEnriched gate.
//
// Trigger: inngest.send({ name: "cruisemapper/port-backfill.requested", data: {} })
// Optional data: { ship_urls?: string[] } — defaults to full ship inventory if omitted.
// Kill switch: CRUISEMAPPER_SAILING_INGEST_ENABLED must be "true" (same as the cron).

import { z } from "zod";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { loadInventoryByKind } from "@/lib/external/cruisemapper/discovery";
import { emptySailingResult, mergeSailing } from "@/lib/external/cruisemapper/sailing-ingest";
import { validateInngestEvent } from "@/lib/inngest/event-registry";
import {
  processOneSailingUrl,
  runSailingWindow,
  isNonCruiseSailingUrl,
  sailingHaltReason,
  alertSailingHalt,
  STEP_BUDGET_MS,
} from "./refresh-cruisemapper-sailings";

export const backfillCruisemapperPorts = inngest.createFunction(
  {
    id: "backfill-cruisemapper-ports",
    triggers: [{ event: "cruisemapper/port-backfill.requested" }],
  },
  async ({ event, step }) => {
    validateInngestEvent("cruisemapper/port-backfill.requested", event.data);
    if (process.env.CRUISEMAPPER_SAILING_INGEST_ENABLED !== "true") {
      return { skipped: true, reason: "CRUISEMAPPER_SAILING_INGEST_ENABLED=false" };
    }
    if (!process.env.CRUISEMAPPER_DIY_USER_AGENT) {
      return { skipped: true, reason: "CRUISEMAPPER_DIY_USER_AGENT not set" };
    }

    const shipUrls = await step.run("load-ships", async () => {
      const parsed = z.object({ ship_urls: z.array(z.string()).optional() }).passthrough().safeParse(event.data);
      const overrideUrls = parsed.success ? parsed.data.ship_urls : undefined;
      if (overrideUrls?.length) {
        return overrideUrls.filter((u) => !isNonCruiseSailingUrl(u));
      }
      const all = await loadInventoryByKind(createServiceRoleClient(), "ship");
      return all.filter((u) => !isNonCruiseSailingUrl(u));
    });

    const sailing = emptySailingResult();
    let fetchErrors = 0;
    let attempted = 0;
    let parseFailures = 0;
    let halted = false;
    let haltReasonStr: string | undefined;

    let cursor = 0;
    let stepNum = 0;
    while (cursor < shipUrls.length) {
      const start = cursor;
      const r = await step.run(`backfill-${stepNum}`, () => {
        const db = createServiceRoleClient();
        return runSailingWindow(
          shipUrls,
          start,
          STEP_BUDGET_MS,
          (url, deadlineMs) => processOneSailingUrl(db, url, deadlineMs, true),
        );
      });
      attempted += r.attempted;
      mergeSailing(sailing, r.sailing);
      fetchErrors += r.fetch_errors;
      parseFailures += r.parse_failed;
      cursor = r.nextIndex;
      stepNum += 1;

      const reason = sailingHaltReason(attempted, parseFailures);
      if (reason) {
        halted = true;
        haltReasonStr = reason;
        await step.run(`halt-${stepNum - 1}`, () => alertSailingHalt(attempted, parseFailures, reason));
        break;
      }
    }

    return {
      ship_pages_attempted: attempted,
      ...sailing,
      fetch_errors: fetchErrors,
      halted,
      ...(haltReasonStr ? { halt_reason: haltReasonStr } : {}),
    };
  },
);
