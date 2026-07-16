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

import type { PostgrestError } from "@supabase/supabase-js";
import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { assertPlatformAdminArea, PlatformAdminError } from "@/lib/auth/assert-platform-admin";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { safeAwait } from "@/lib/db/safe-mutation";
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

async function loadCurrent(
  db: PlatformDb,
): Promise<Record<WeightKey, number>> {
  const { data, error } = await db
    .from("platform_settings")
    .select("key, value")
    .in("key", WEIGHT_KEYS.map(settingKey));
  // #1909 — a failed read used to be discarded, rendering the seed defaults as
  // if they were the live config. An admin would see 1.0 across the board and
  // could "correct" a value that was never actually wrong.
  if (error) throw new Error(`retrieval-weights read failed: ${String(error)}`);
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
        // #1936 (D-091 #22) — apply every requested key in ONE transaction via
        // the platform_settings_apply_updates RPC. A per-key fan-out would
        // autocommit each UPDATE independently (withPlatformAdminAudit opens no
        // transaction), so a mixed PUT where one key matched no row left the
        // applied key durably committed in main while the route threw 500 and
        // published no RAG-sync event — main and the rag replica diverged until
        // the nightly reconcile cron (up to 24h) and the admin never learned a
        // key had taken effect. The RPC RAISEs on any zero-row key, rolling
        // back the whole call, so a partial PUT applies nothing.
        const entries = Object.entries(requested) as Array<[WeightKey, number]>;
        const changes = entries.map(([w, value]) => ({ key: settingKey(w), value }));
        recordQuery({ op: "rpc", table: "platform_settings", rpc_name: "platform_settings_apply_updates" });
        const applied = await safeAwait(
          (db as unknown as PlatformDb).rpc("platform_settings_apply_updates", { p_changes: changes }),
          "platform_settings.rpc.apply_updates",
        );
        // Success returns one row per applied key. An empty/null result without
        // a raised error would mean the function committed nothing — fail loud
        // rather than publish a sync for state that may not have persisted (and
        // it keeps source_revision's Math.max off the -Infinity path, #1887).
        if (!applied || applied.length === 0) {
          throw new Error("platform_settings_apply_updates returned no rows");
        }
        // source_revision mirrors the platform-settings GET route: the DB row's
        // updated_at (actual write time), floored to epoch seconds, so RAG-side
        // stale-write detection compares against the real write.
        const sourceRevision = Math.max(
          ...applied.map((r) => Math.floor(new Date(r.setting_updated_at).getTime() / 1000)),
        );

        // #1826 — enqueue the RAG-sync event after the write commits.
        // publishPlatformEvent never throws (enqueue failures alert
        // internally); bare-await, matching every other publish*Event
        // caller (e.g. activate-tenant.ts, signup/complete/route.ts).
        await publishPlatformEvent({
          event_type: "platform_settings.updated",
          source_revision: sourceRevision,
          payload: { changes },
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
