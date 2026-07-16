// #1936 (D-091 #22) — feedback-settings PUT mirrors retrieval-weights: every
// per-key platform_settings change is applied through ONE atomic RPC
// (platform_settings_apply_updates), not a per-key fan-out. A mixed PUT where
// one key's row is missing must leave NO key applied and publish no RAG-sync
// event (the pre-#1936 fan-out committed the applied key and diverged main from
// the rag replica for up to 24h). These tests pin: a single rpc call carrying
// every requested key (the mock db exposes no .update, so a fan-out regression
// throws); any RPC failure aborts the whole PUT with a generic db_error 500 and
// no publish; plus the per-key validation bounds (adjustment_limit is
// fractional; the day/count knobs are positive integers).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rpcCalls: [] as Array<Array<{ key: string; value: unknown }>>,
  // Keys that make the atomic RPC fail with a DB error (rollback: no key applied).
  failKeys: new Set<string>(),
  // Keys that make the atomic RPC RAISE "matched no row" — also a full rollback.
  missingRowKeys: new Set<string>(),
  currentRows: [] as Array<{ key: string; value: unknown }>,
  // When set, the loadCurrent read returns this error instead of rows.
  readError: null as { message: string } | null,
  publishPlatformEvent: vi.fn(async (_event: unknown) => undefined),
}));

vi.mock("@/lib/auth/assert-platform-admin", () => ({
  assertPlatformAdminArea: async () => ({ admin_user_id: "admin-user-1" }),
  PlatformAdminError: class extends Error {},
}));

vi.mock("@/lib/rag-sync/publish-platform-event", () => ({
  publishPlatformEvent: h.publishPlatformEvent,
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: async (
    _opts: unknown,
    fn: (db: unknown, recordQuery: (q: unknown) => void) => Promise<unknown>,
  ) => {
    const db = {
      // No `.update`: the route must go through `.rpc`. A regression to a
      // per-key `.from(...).update(...)` fan-out throws "update is not a function".
      from: (_table: string) => ({
        select: () => ({
          in: async () => (h.readError ? { data: null, error: h.readError } : { data: h.currentRows, error: null }),
        }),
      }),
      rpc: async (_fn: string, args: { p_changes: Array<{ key: string; value: unknown }> }) => {
        h.rpcCalls.push(args.p_changes);
        const failed = args.p_changes.find((c) => h.failKeys.has(c.key));
        if (failed) return { data: null, error: { message: `apply_updates failed at ${failed.key}` } };
        const missing = args.p_changes.find((c) => h.missingRowKeys.has(c.key));
        if (missing) {
          return { data: null, error: { message: `platform_settings key ${missing.key} matched no row`, code: "P0002" } };
        }
        return {
          data: args.p_changes.map((c) => ({ setting_key: c.key, setting_updated_at: "2026-07-13T00:00:00.000Z" })),
          error: null,
        };
      },
    };
    return fn(db, () => {});
  },
}));

import { PUT, GET } from "@/app/api/admin/feedback-settings/route";

function req(body: unknown): Request {
  return new Request("https://app.example.com/api/admin/feedback-settings", {
    method: "PUT",
    headers: { "content-type": "application/json", Authorization: "Bearer admin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.rpcCalls = [];
  h.failKeys = new Set();
  h.missingRowKeys = new Set();
  h.currentRows = [];
  h.readError = null;
  h.publishPlatformEvent.mockClear();
});

describe("PUT /api/admin/feedback-settings — missing seed row (#1909, now via the atomic RPC RAISE)", () => {
  // A missing platform_settings row makes the RPC RAISE "matched no row",
  // aborting the whole transaction. A mixed PUT where one key's row is missing
  // must leave NO key applied and publish nothing — the pre-#1936 fan-out
  // committed the sibling key and diverged main from the rag replica.
  it("fails the whole PUT when ONE key's row is missing even though a sibling key would apply", async () => {
    h.missingRowKeys = new Set(["feedback_period_days"]);
    const res = await PUT(req({ feedback_period_days: 30, feedback_min_signal_count: 5 }));

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "db_error" });
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.publishPlatformEvent).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/feedback-settings — read error (#1909)", () => {
  // A discarded read error rendered the seed defaults as if they were live
  // config — an admin could "correct" a value that was never wrong.
  it("returns db_error rather than seed defaults when the settings read fails", async () => {
    h.readError = { message: "connection reset" };
    const res = await GET(new Request("https://app.example.com/api/admin/feedback-settings"));

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "db_error" });
    expect(body).not.toMatchObject({ feedback_adjustment_limit: 0.05 });
  });
});

describe("GET /api/admin/feedback-settings", () => {
  it("returns seed defaults for keys with no stored row", async () => {
    h.currentRows = [{ key: "feedback_period_days", value: 45 }];
    const res = await GET(new Request("https://app.example.com/api/admin/feedback-settings"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body).toMatchObject({
      feedback_adjustment_limit: 0.05,
      feedback_min_signal_count: 2,
      feedback_period_days: 45, // overridden by the stored row
      feedback_decay_halflife_days: 90,
    });
  });
});

describe("PUT /api/admin/feedback-settings — atomic apply (#1936)", () => {
  it("applies every requested key through a single RPC and returns the re-read values", async () => {
    h.currentRows = [
      { key: "feedback_adjustment_limit", value: 0.1 },
      { key: "feedback_period_days", value: 60 },
    ];
    const res = await PUT(req({ feedback_adjustment_limit: 0.1, feedback_period_days: 60 }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { updated: string[]; values: Record<string, number> };
    expect(body.updated.sort()).toEqual(["feedback_adjustment_limit", "feedback_period_days"]);
    // Values come from the post-update re-read, not the request echo.
    expect(body.values).toMatchObject({
      feedback_adjustment_limit: 0.1,
      feedback_period_days: 60,
      feedback_min_signal_count: 2,
      feedback_decay_halflife_days: 90,
    });
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.rpcCalls[0]!.map((c) => c.key).sort()).toEqual([
      "feedback_adjustment_limit",
      "feedback_period_days",
    ]);
  });

  it("a single failing key aborts the whole PUT — no key applied, no sync (atomicity)", async () => {
    h.failKeys = new Set(["feedback_period_days"]);
    const res = await PUT(
      req({ feedback_period_days: 30, feedback_min_signal_count: 3, feedback_decay_halflife_days: 120 }),
    );

    // Generic db_error 500 — no key names / raw DB details in the client body.
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "db_error" });
    expect(JSON.stringify(body)).not.toContain("feedback_period_days");

    // All three keys went into ONE transactional RPC that rolled back — no
    // per-key path could have persisted a subset.
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.rpcCalls[0]!.map((c) => c.key).sort()).toEqual([
      "feedback_decay_halflife_days",
      "feedback_min_signal_count",
      "feedback_period_days",
    ]);
    expect(h.publishPlatformEvent).not.toHaveBeenCalled();
  });
});

describe("PUT /api/admin/feedback-settings — validation", () => {
  it("rejects an out-of-range adjustment_limit before touching the DB", async () => {
    const res = await PUT(req({ feedback_adjustment_limit: 5 }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; key: string };
    expect(body.error).toBe("invalid_feedback_setting");
    expect(body.key).toBe("feedback_adjustment_limit");
    expect(h.rpcCalls).toEqual([]);
  });

  // Spec §6.10 bounds adjustment_limit to [0, 0.5]. 0.8 is a finite fractional
  // number that an earlier [0, 1] bound would have accepted — this pins the
  // spec bound so a regression back to the looser range fails here.
  it("rejects an adjustment_limit above the §6.10 spec max (0.5) even though it is < 1", async () => {
    const res = await PUT(req({ feedback_adjustment_limit: 0.8 }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; key: string };
    expect(body.error).toBe("invalid_feedback_setting");
    expect(body.key).toBe("feedback_adjustment_limit");
    expect(h.rpcCalls).toEqual([]);
  });

  // min_signal_count spec max is 100 (was 1000); decay_halflife spec max is 365
  // (was 3650). Values inside the old bounds must now be rejected.
  it("rejects a min_signal_count above the §6.10 spec max (100)", async () => {
    const res = await PUT(req({ feedback_min_signal_count: 500 }));
    expect(res.status).toBe(422);
    expect(h.rpcCalls).toEqual([]);
  });

  it("rejects a decay_halflife_days above the §6.10 spec max (365)", async () => {
    const res = await PUT(req({ feedback_decay_halflife_days: 1000 }));
    expect(res.status).toBe(422);
    expect(h.rpcCalls).toEqual([]);
  });

  it("rejects a non-integer for an integer-only key before touching the DB", async () => {
    const res = await PUT(req({ feedback_min_signal_count: 2.5 }));
    expect(res.status).toBe(422);
    expect(h.rpcCalls).toEqual([]);
  });

  it("rejects an empty body with no eligible keys", async () => {
    const res = await PUT(req({ unrelated: 1 }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no_settings_provided");
    expect(h.rpcCalls).toEqual([]);
  });
});

describe("PUT /api/admin/feedback-settings — RAG-sync publish", () => {
  it("calls publishPlatformEvent with the changed keys/values after a successful save", async () => {
    h.currentRows = [
      { key: "feedback_adjustment_limit", value: 0.1 },
      { key: "feedback_min_signal_count", value: 5 },
    ];
    const res = await PUT(req({ feedback_adjustment_limit: 0.1, feedback_min_signal_count: 5 }));
    expect(res.status).toBe(200);

    expect(h.publishPlatformEvent).toHaveBeenCalledTimes(1);
    const event = h.publishPlatformEvent.mock.calls[0]![0] as {
      event_type: string;
      source_revision: number;
      payload: { changes: Array<{ key: string; value: unknown }> };
    };
    expect(event.event_type).toBe("platform_settings.updated");
    // source_revision comes from the RPC's returned updated_at, not Date.now().
    expect(event.source_revision).toBe(Math.floor(new Date("2026-07-13T00:00:00.000Z").getTime() / 1000));
    expect(event.payload.changes.slice().sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "feedback_adjustment_limit", value: 0.1 },
      { key: "feedback_min_signal_count", value: 5 },
    ]);
  });

  it("does not call publishPlatformEvent when the DB write fails", async () => {
    h.failKeys = new Set(["feedback_period_days"]);
    const res = await PUT(req({ feedback_period_days: 30 }));
    expect(res.status).toBe(500);
    expect(h.publishPlatformEvent).not.toHaveBeenCalled();
  });
});
