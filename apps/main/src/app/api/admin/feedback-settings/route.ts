// #1888 §6.10 — Platform-admin GET/PUT for the four feedback_* retrieval knobs.
//
// GET  /api/admin/feedback-settings
//   → { feedback_adjustment_limit, feedback_min_signal_count,
//       feedback_period_days, feedback_decay_halflife_days }  (numbers, seed
//       defaults if unset)
//
// PUT  /api/admin/feedback-settings
//   Body: any subset of the four keys above (numbers)
//   → { updated: [...keys], values: { …all four } }
//
// These are global platform settings (no tenant_id column on
// platform_settings). All writes audit through withPlatformAdminAudit with
// reason="feedback_settings_change".
//
// Unlike retrieval-weights, these four keys ARE in publish-platform-event.ts's
// SYNC_ELIGIBLE_KEYS — so publishPlatformEvent enqueues a real RAG-sync event
// after a successful write. compute_feedback_factor on the rag side (migration
// 0005) reads them; the nightly platform-settings-reconcile cron is the
// backstop for direct-DB edits.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { publishPlatformEvent } from "@/lib/rag-sync/publish-platform-event";

type FeedbackKey =
  | "feedback_adjustment_limit"
  | "feedback_min_signal_count"
  | "feedback_period_days"
  | "feedback_decay_halflife_days";

// Per-key semantics (seed defaults live in migration
// 20260521180000_platform_settings.sql). Each key has its own bounds:
//   adjustment_limit — a small unsigned magnitude cap on the signed feedback
//     adjustment (0 disables feedback influence); a fractional score delta.
//   min_signal_count / period_days / halflife_days — positive integer counts.
interface KeySpec {
  integer: boolean;
  min: number;
  max: number;
  default: number;
}

const FEEDBACK_KEYS: Record<FeedbackKey, KeySpec> = {
  feedback_adjustment_limit: { integer: false, min: 0, max: 1, default: 0.05 },
  feedback_min_signal_count: { integer: true, min: 1, max: 1000, default: 2 },
  feedback_period_days: { integer: true, min: 1, max: 365, default: 30 },
  feedback_decay_halflife_days: { integer: true, min: 1, max: 3650, default: 90 },
};

const KEYS = Object.keys(FEEDBACK_KEYS) as FeedbackKey[];

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

async function loadCurrent(db: PlatformDb): Promise<Record<FeedbackKey, number>> {
  const { data } = await db.from("platform_settings").select("key, value").in("key", KEYS);
  const out = { ...Object.fromEntries(KEYS.map((k) => [k, FEEDBACK_KEYS[k].default])) } as Record<FeedbackKey, number>;
  for (const row of data ?? []) {
    if ((KEYS as string[]).includes(row.key)) {
      const n = typeof row.value === "number" ? row.value : Number(row.value);
      if (Number.isFinite(n)) out[row.key as FeedbackKey] = n;
    }
  }
  return out;
}

export async function GET(req: Request): Promise<Response> {
  let adminUserId: string;
  try {
    adminUserId = (await assertPlatformAdminArea(req, "feedback_settings")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "feedback_settings_change", operation: "feedback_settings.list" },
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
    adminUserId = (await assertPlatformAdminArea(req, "feedback_settings")).admin_user_id;
  } catch (e) {
    if (e instanceof PlatformAdminError) return e.toResponse();
    throw e;
  }

  let body: Partial<Record<FeedbackKey, unknown>>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const requested: Partial<Record<FeedbackKey, number>> = {};
  for (const key of KEYS) {
    if (body[key] === undefined) continue;
    const spec = FEEDBACK_KEYS[key];
    const n = typeof body[key] === "number" ? (body[key] as number) : Number(body[key]);
    // Static message only — never echo raw input back (D-091 #16).
    if (!Number.isFinite(n) || n < spec.min || n > spec.max || (spec.integer && !Number.isInteger(n))) {
      return Response.json(
        {
          error: "invalid_feedback_setting",
          key,
          message: `${key} must be ${spec.integer ? "an integer" : "a finite number"} in [${spec.min}, ${spec.max}]`,
        },
        { status: 422 },
      );
    }
    requested[key] = n;
  }

  if (Object.keys(requested).length === 0) {
    return Response.json({ error: "no_settings_provided" }, { status: 422 });
  }

  try {
    const result = await withPlatformAdminAudit(
      { admin_user_id: adminUserId, reason: "feedback_settings_change", operation: "feedback_settings.update" },
      async (db, recordQuery) => {
        // Each key is its own platform_settings row, so the updates are
        // independent — fan out. allSettled (not fail-fast all) so a mid-batch
        // failure still observes every sibling's outcome instead of racing
        // still-in-flight updates; report the applied/failed split in the
        // thrown error (server-log only — the client gets generic db_error).
        const entries = Object.entries(requested) as Array<[FeedbackKey, number]>;
        const settled = await Promise.allSettled(
          entries.map(async ([key, value]) => {
            recordQuery({ op: "update", table: "platform_settings" });
            const { data, error } = await (db as unknown as PlatformDb)
              .from("platform_settings")
              .update({ value })
              .eq("key", key)
              .select("updated_at");
            if (error) throw new Error(`update ${key} failed: ${String(error)}`);
            return data?.[0]?.updated_at;
          }),
        );
        const failedKeys = entries.filter((_, i) => settled[i]?.status === "rejected").map(([k]) => k);
        if (failedKeys.length > 0) {
          const appliedKeys = entries.filter((_, i) => settled[i]?.status === "fulfilled").map(([k]) => k);
          throw new Error(
            `feedback-settings update partial failure — failed: [${failedKeys.join(", ")}], applied: [${appliedKeys.join(", ")}]`,
          );
        }

        // source_revision mirrors the platform-settings GET route: the DB
        // row's updated_at (actual write time), not wall-clock at call time,
        // so RAG-side stale-write detection compares against the real write.
        const updatedAts = settled
          .filter((s): s is PromiseFulfilledResult<string | undefined> => s.status === "fulfilled")
          .map((s) => s.value)
          .filter((v): v is string => v !== undefined);
        // Empty-updatedAts guard (PR #1900's intent; not yet on dev): if no row
        // returned an updated_at, Math.max(...[]) is -Infinity — a poison
        // source_revision. Fall back to now so the sync event stays orderable.
        const sourceRevision =
          updatedAts.length > 0
            ? Math.max(...updatedAts.map((v) => Math.floor(new Date(v).getTime() / 1000)))
            : Math.floor(Date.now() / 1000);

        // Enqueue the RAG-sync event after the write commits. These four keys
        // are sync-eligible, so this produces real traffic. publishPlatformEvent
        // never throws (enqueue failures alert internally); bare-await, matching
        // every other publish*Event caller.
        await publishPlatformEvent({
          event_type: "platform_settings.updated",
          source_revision: sourceRevision,
          payload: { changes: entries.map(([key, value]) => ({ key, value })) },
        });

        const updated: FeedbackKey[] = entries.map(([k]) => k);
        const values = await loadCurrent(db as unknown as PlatformDb);
        return { updated, values };
      },
    );
    return Response.json(result);
  } catch (err) {
    return dbErrorResponse(err);
  }
}
