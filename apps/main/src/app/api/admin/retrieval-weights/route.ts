// BP22 §6 — Platform-admin GET/PUT for the four composite-weight knobs.
//
// GET  /api/admin/retrieval-weights
//   → { match, authority, recency, feedback }  (numbers, defaults to 1.0 if unset)
//
// PUT  /api/admin/retrieval-weights
//   Body: { match?, authority?, recency?, feedback? }   (any subset)
//   → { updated: [...keys], values: { match, authority, recency, feedback } }
//
// Weights are global platform settings — tenants cannot override (no tenant_id
// column on platform_settings). All writes audit through withPlatformAdminAudit
// with reason="retrieval_weights_change".
//
// Note: this updates the MAIN-side canonical row. The rag-side replica
// (apps/rag/supabase/migrations/0006_platform_settings_replica.sql) is kept
// in sync two ways: publishPlatformEvent below (retrieval_weight_* is in
// publish-platform-event.ts's SYNC_ELIGIBLE_KEYS as of #1887) delivers the
// change immediately via rag-sync-deliver, and the nightly
// platform-settings-reconcile cron (apps/rag/src/inngest/
// platform-settings-reconcile.ts, identical allowlist) catches drift from
// any dropped delivery.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { publishPlatformEvent } from "@/lib/rag-sync/publish-platform-event";

type WeightKey = "match" | "authority" | "recency" | "feedback";
const WEIGHT_KEYS: readonly WeightKey[] = ["match", "authority", "recency", "feedback"];

function settingKey(weight: WeightKey): string {
  return `retrieval_weight_${weight}`;
}

const MIN_WEIGHT = 0;
const MAX_WEIGHT = 10;

interface PlatformDb {
  from: (table: string) => {
    select: (cols: string) => {
      in: (col: string, vals: string[]) => Promise<{ data: Array<{ key: string; value: unknown }> | null; error: unknown }>;
    };
    update: (row: Record<string, unknown>) => {
      eq: (
        col: string,
        val: string,
      ) => {
        select: (cols: string) => Promise<{ data: Array<{ updated_at: string }> | null; error: unknown }>;
      };
    };
  };
}

async function loadCurrent(
  db: PlatformDb,
): Promise<Record<WeightKey, number>> {
  const { data } = await db
    .from("platform_settings")
    .select("key, value")
    .in("key", WEIGHT_KEYS.map(settingKey));
  const out: Record<WeightKey, number> = { match: 1, authority: 1, recency: 1, feedback: 1 };
  for (const row of data ?? []) {
    for (const w of WEIGHT_KEYS) {
      if (row.key === settingKey(w)) {
        const n = typeof row.value === "number" ? row.value : Number(row.value);
        if (Number.isFinite(n)) out[w] = n;
      }
    }
  }
  return out;
}

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "retrieval_weights")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "retrieval_weights_change", operation: "retrieval_weights.list" },
      async (db, recordQuery) => {
        recordQuery({ op: "select", table: "platform_settings" });
        return loadCurrent(db as unknown as PlatformDb);
      },
    );
    return Response.json(result);
  } catch (err) {
    return dbErrorResponse(err);
  }
}

export async function PUT(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "retrieval_weights")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: Partial<Record<WeightKey, unknown>>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const requested: Partial<Record<WeightKey, number>> = {};
  for (const w of WEIGHT_KEYS) {
    if (body[w] === undefined) continue;
    const n = typeof body[w] === "number" ? (body[w] as number) : Number(body[w]);
    if (!Number.isFinite(n) || n < MIN_WEIGHT || n > MAX_WEIGHT) {
      return Response.json(
        { error: `invalid_weight`, key: w, message: `weight must be a finite number in [${MIN_WEIGHT}, ${MAX_WEIGHT}]` },
        { status: 422 },
      );
    }
    requested[w] = n;
  }

  if (Object.keys(requested).length === 0) {
    return Response.json({ error: "no_weights_provided" }, { status: 422 });
  }

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "retrieval_weights_change", operation: "retrieval_weights.update" },
      async (db, recordQuery) => {
        // Each weight lives on its own platform_settings row (different key),
        // so the updates are independent — fan out instead of one
        // round-trip per key. allSettled (not all) because the weights are
        // a cohesive scoring config read together downstream: a fail-fast
        // rejection would race the still-in-flight sibling updates and lose
        // track of which keys actually applied. On any failure, report the
        // applied/failed split in the thrown error so the audit log and
        // server logs show the true partial state.
        const entries = Object.entries(requested) as Array<[WeightKey, number]>;
        const settled = await Promise.allSettled(
          entries.map(async ([w, value]) => {
            recordQuery({ op: "update", table: "platform_settings" });
            const { data, error } = await (db as unknown as PlatformDb)
              .from("platform_settings")
              .update({ value })
              .eq("key", settingKey(w))
              .select("updated_at");
            if (error) throw new Error(`update ${settingKey(w)} failed: ${String(error)}`);
            return data?.[0]?.updated_at;
          }),
        );
        const failedKeys = entries
          .filter((_, i) => settled[i]?.status === "rejected")
          .map(([w]) => settingKey(w));
        if (failedKeys.length > 0) {
          const appliedKeys = entries
            .filter((_, i) => settled[i]?.status === "fulfilled")
            .map(([w]) => settingKey(w));
          throw new Error(
            `retrieval-weights update partial failure — failed: [${failedKeys.join(", ")}], applied: [${appliedKeys.join(", ")}]`,
          );
        }
        // source_revision mirrors the platform-settings GET route: the DB
        // row's updated_at, not wall-clock at call time, so RAG-side
        // stale-write detection compares against the actual DB write.
        const updatedAts = settled
          .filter((s): s is PromiseFulfilledResult<string | undefined> => s.status === "fulfilled")
          .map((s) => s.value)
          .filter((v): v is string => v !== undefined);
        // Every entry above either threw (caught as a settled rejection) or
        // returned an updated_at — an empty array here means the update
        // succeeded with error:null but the row had no updated_at, which
        // shouldn't happen against the seeded retrieval_weight_* rows. Now
        // that source_revision reaches rag (#1887), Math.max(...[]) would
        // silently produce -Infinity and cause the rag-side stale-revision
        // guard to skip every key forever — fail loud instead.
        if (updatedAts.length === 0) {
          throw new Error("retrieval-weights update: no updated_at returned for any key");
        }
        const sourceRevision = Math.max(...updatedAts.map((v) => Math.floor(new Date(v).getTime() / 1000)));

        // #1826 — enqueue the RAG-sync event after the write commits.
        // publishPlatformEvent never throws (enqueue failures alert
        // internally); bare-await, matching every other publish*Event
        // caller (e.g. activate-tenant.ts, signup/complete/route.ts).
        await publishPlatformEvent({
          event_type: "platform_settings.updated",
          source_revision: sourceRevision,
          payload: { changes: entries.map(([w, value]) => ({ key: settingKey(w), value })) },
        });

        const updated: WeightKey[] = entries.map(([w]) => w);
        const values = await loadCurrent(db as unknown as PlatformDb);
        return {
          updated,
          values,
          _changes: { keys: updated.map(settingKey), new_values: values },
        };
      },
    );
    return Response.json(result);
  } catch (err) {
    return dbErrorResponse(err);
  }
}
