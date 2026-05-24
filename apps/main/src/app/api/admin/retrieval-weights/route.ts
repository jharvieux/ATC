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
// (apps/rag/supabase/migrations/0006_platform_settings_replica.sql) needs
// to be kept in sync — the sync mechanism is deferred (see D-041); for now
// changes here MUST be mirrored manually into the rag DB until the sync
// job lands, or composite scoring will use stale weights.

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";

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
      eq: (col: string, val: string) => Promise<{ error: unknown }>;
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
  const adminUserId = req.headers.get("x-admin-user-id");
  if (!adminUserId) return Response.json({ error: "x-admin-user-id required" }, { status: 401 });

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
    return Response.json({ error: String(err) }, { status: 500 });
  }
}

export async function PUT(req: Request): Promise<Response> {
  const adminUserId = req.headers.get("x-admin-user-id");
  if (!adminUserId) return Response.json({ error: "x-admin-user-id required" }, { status: 401 });

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
        const updated: WeightKey[] = [];
        for (const [w, value] of Object.entries(requested) as Array<[WeightKey, number]>) {
          recordQuery({ op: "update", table: "platform_settings" });
          const { error } = await (db as unknown as PlatformDb)
            .from("platform_settings")
            .update({ value })
            .eq("key", settingKey(w));
          if (error) throw new Error(`update ${settingKey(w)} failed: ${String(error)}`);
          updated.push(w);
        }
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
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
