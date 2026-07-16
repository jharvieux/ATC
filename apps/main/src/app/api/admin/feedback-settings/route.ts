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

import type { PostgrestError } from "@supabase/supabase-js";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { safeAwait } from "@/lib/db/safe-mutation";
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

// Ranges are the §6.10 range table (section-06-rag-service-schema.html) — the
// spec is the source of truth for these bounds.
const FEEDBACK_KEYS: Record<FeedbackKey, KeySpec> = {
  feedback_adjustment_limit: { integer: false, min: 0, max: 0.5, default: 0.05 },
  feedback_min_signal_count: { integer: true, min: 1, max: 100, default: 2 },
  feedback_period_days: { integer: true, min: 1, max: 365, default: 30 },
  feedback_decay_halflife_days: { integer: true, min: 1, max: 365, default: 90 },
};

const KEYS = Object.keys(FEEDBACK_KEYS) as FeedbackKey[];

interface PlatformDb {
  from: (table: string) => {
    select: (cols: string) => {
      in: (
        col: string,
        vals: string[],
      ) => Promise<{ data: Array<{ key: string; value: unknown }> | null; error: PostgrestError | null }>;
    };
  };
  rpc: (
    fn: "platform_settings_apply_updates",
    args: { p_changes: Array<{ key: string; value: number }> },
  ) => Promise<{ data: Array<{ setting_key: string; setting_updated_at: string }> | null; error: PostgrestError | null }>;
}

async function loadCurrent(db: PlatformDb): Promise<Record<FeedbackKey, number>> {
  const { data, error } = await db.from("platform_settings").select("key, value").in("key", KEYS);
  // #1909 — a failed read used to be discarded, rendering the seed defaults as
  // if they were the live config. An admin would see the defaults and could
  // "correct" a value that was never actually wrong.
  if (error) throw new Error(`feedback-settings read failed: ${String(error)}`);
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
        // #1936 (D-091 #22) — apply every requested key in ONE transaction via
        // the platform_settings_apply_updates RPC. A per-key fan-out would
        // autocommit each UPDATE independently (withPlatformAdminAudit opens no
        // transaction), so a mixed PUT where one key matched no row left the
        // applied key durably committed in main while the route threw 500 and
        // published no RAG-sync event — main and the rag replica diverged until
        // the nightly reconcile cron (up to 24h) and the admin never learned a
        // key had taken effect. The RPC RAISEs on any zero-row key, rolling
        // back the whole call, so a partial PUT applies nothing.
        const entries = Object.entries(requested) as Array<[FeedbackKey, number]>;
        const changes = entries.map(([key, value]) => ({ key, value }));
        recordQuery({ op: "rpc", table: "platform_settings", rpc_name: "platform_settings_apply_updates" });
        const applied = await safeAwait(
          (db as unknown as PlatformDb).rpc("platform_settings_apply_updates", { p_changes: changes }),
          "platform_settings.rpc.apply_updates",
        );
        // Success returns one row per applied key. An empty/null result without
        // a raised error would mean the function committed nothing — fail loud
        // rather than publish a sync for state that may not have persisted (and
        // it keeps source_revision's Math.max off the -Infinity path).
        if (!applied || applied.length === 0) {
          throw new Error("platform_settings_apply_updates returned no rows");
        }
        // source_revision mirrors the platform-settings GET route: the DB row's
        // updated_at (actual write time), floored to epoch seconds, so RAG-side
        // stale-write detection compares against the real write.
        const sourceRevision = Math.max(
          ...applied.map((r) => Math.floor(new Date(r.setting_updated_at).getTime() / 1000)),
        );

        // Enqueue the RAG-sync event after the write commits. These four keys
        // are sync-eligible, so this produces real traffic. publishPlatformEvent
        // never throws (enqueue failures alert internally); bare-await, matching
        // every other publish*Event caller.
        await publishPlatformEvent({
          event_type: "platform_settings.updated",
          source_revision: sourceRevision,
          payload: { changes },
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
