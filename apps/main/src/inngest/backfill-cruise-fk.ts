// #781 Phase 2 Step 2 — On-demand backfill: populate cruise_line_id / cruise_ship_id
// FKs on quote_options, bookings, groups, and price_watches from free-text.
//
// Trigger: inngest.send({ name: "cruise.fk_backfill_requested", data: {} })
// Optional: { tables?: Array<"quote_options"|"bookings"|"groups"|"price_watches"> }
//   defaults to all four tables.
//
// For each row with a non-null free-text field and a null FK column:
//   matched   → writes the FK, leaves free-text intact (expand phase).
//   unmatched → upserts a pending row in canonical_match_reviews for admin review.
//
// Idempotent — rows that already have a non-null FK are skipped.
// Uses id-cursor + batch drain loop (#774 pattern).

import { z } from "zod";
import { inngest } from "./client";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { resolveCanonical, queueForReview } from "@/lib/canonical/resolve-canonical";
import { safeAwait } from "@/lib/db/safe-mutation";

const BATCH = 100;

type TargetTable = "quote_options" | "bookings" | "groups" | "price_watches";

const ALL_TABLES: TargetTable[] = ["quote_options", "bookings", "groups", "price_watches"];

const PayloadSchema = z.object({
  tables: z.array(z.enum(["quote_options", "bookings", "groups", "price_watches"])).optional(),
}).optional();

// Column name for the free-text ship field varies by table.
const SHIP_COL: Record<TargetTable, string> = {
  quote_options: "ship_name",
  bookings: "ship_name",
  groups: "ship_name",
  price_watches: "ship",
};

type BackfillRow = { id: string; cruise_line: string | null; [k: string]: unknown };

export const backfillCruiseFk = inngest.createFunction(
  {
    id: "backfill-cruise-fk",
    triggers: [{ event: "cruise.fk_backfill_requested" }],
  },
  async ({ event, step }) => {
    const svc = createServiceRoleClient();

    const payload = PayloadSchema.parse(event.data);
    const tables: TargetTable[] =
      Array.isArray(payload?.tables) && payload.tables.length > 0
        ? payload.tables
        : ALL_TABLES;

    const summary: Record<string, { matched: number; queued: number; skipped: number }> = {};

    for (const table of tables) {
      const shipCol = SHIP_COL[table];

      const result = await step.run(`backfill-${table}`, async () => {
        let cursor = "";
        let matched = 0;
        let queued = 0;
        let skipped = 0;

        while (true) {
          const baseQuery = svc
            .from(table)
            .select(`id, cruise_line, ${shipCol}`)
            .is("cruise_line_id", null)
            .not("cruise_line", "is", null)
            .order("id")
            .limit(BATCH);

          const { data: rows, error } = cursor
            ? await baseQuery.gt("id", cursor)
            : await baseQuery;

          if (error) throw new Error(`${table}.select failed: ${error.message}`);
          if (!rows || rows.length === 0) break;

          const typedRows = rows as unknown as BackfillRow[];

          for (const row of typedRows) {
            const lineRaw = row.cruise_line;
            const shipRaw = row[shipCol] as string | null;

            const [lineResult, shipResult] = await Promise.all([
              resolveCanonical(lineRaw, "line", svc),
              resolveCanonical(shipRaw, "ship", svc),
            ]);

            const update: Record<string, string | null> = {
              cruise_line_id: lineResult.matched ? lineResult.id : null,
              cruise_ship_id: shipResult.matched ? shipResult.id : null,
            };

            if (lineResult.matched || shipResult.matched) {
              await safeAwait(
                svc.from(table).update(update).eq("id", row.id),
                `${table}.update.cruise_fk`,
              );
              matched++;
            } else {
              skipped++;
            }

            if (!lineResult.matched && lineRaw?.trim()) {
              await queueForReview(lineRaw, "line", { table, column: "cruise_line" }, svc);
              queued++;
            }
            if (!shipResult.matched && shipRaw?.trim()) {
              await queueForReview(shipRaw, "ship", { table, column: shipCol }, svc);
              queued++;
            }
          }

          cursor = typedRows[typedRows.length - 1]!.id;
          if (rows.length < BATCH) break;
        }

        return { matched, queued, skipped };
      });

      summary[table] = result as { matched: number; queued: number; skipped: number };
    }

    return { summary };
  },
);
