// #1888 — feedback-settings PUT mirrors retrieval-weights: parallel per-key
// platform_settings updates (allSettled, not fail-fast), generic dbErrorResponse
// on any failure (no key names in the client body), and — because these four
// keys ARE sync-eligible — a publishPlatformEvent enqueue after a successful
// write. These tests pin those guarantees plus the per-key validation bounds
// (adjustment_limit is fractional; the day/count knobs are positive integers).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  updates: [] as Array<{ key: string; value: unknown }>,
  failKeys: new Set<string>(),
  currentRows: [] as Array<{ key: string; value: unknown }>,
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
      from: (_table: string) => ({
        update: (payload: { value: unknown }) => ({
          eq: (_col: string, key: string) => ({
            select: async (_cols: string) => {
              h.updates.push({ key, value: payload.value });
              return h.failKeys.has(key)
                ? { data: null, error: { message: `write failed for ${key}` } }
                : { data: [{ updated_at: "2026-07-13T00:00:00.000Z" }], error: null };
            },
          }),
        }),
        select: () => ({
          in: async () => ({ data: h.currentRows, error: null }),
        }),
      }),
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
  h.updates = [];
  h.failKeys = new Set();
  h.currentRows = [];
  h.publishPlatformEvent.mockClear();
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

describe("PUT /api/admin/feedback-settings — parallel per-key updates", () => {
  it("updates every requested key and returns the re-read values", async () => {
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
    expect(h.updates.map((u) => u.key).sort()).toEqual([
      "feedback_adjustment_limit",
      "feedback_period_days",
    ]);
  });

  it("one key failing still attempts the sibling updates (allSettled, not fail-fast)", async () => {
    h.failKeys = new Set(["feedback_period_days"]);
    const res = await PUT(
      req({ feedback_period_days: 30, feedback_min_signal_count: 3, feedback_decay_halflife_days: 120 }),
    );

    // Failure surfaces as the generic db_error 500 — no key names / raw DB
    // details in the client-visible body.
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "db_error" });
    expect(JSON.stringify(body)).not.toContain("feedback_period_days");

    // All three updates were attempted despite the mid-batch failure.
    expect(h.updates.map((u) => u.key).sort()).toEqual([
      "feedback_decay_halflife_days",
      "feedback_min_signal_count",
      "feedback_period_days",
    ]);
  });
});

describe("PUT /api/admin/feedback-settings — validation", () => {
  it("rejects an out-of-range adjustment_limit before touching the DB", async () => {
    const res = await PUT(req({ feedback_adjustment_limit: 5 }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; key: string };
    expect(body.error).toBe("invalid_feedback_setting");
    expect(body.key).toBe("feedback_adjustment_limit");
    expect(h.updates).toEqual([]);
  });

  it("rejects a non-integer for an integer-only key before touching the DB", async () => {
    const res = await PUT(req({ feedback_min_signal_count: 2.5 }));
    expect(res.status).toBe(422);
    expect(h.updates).toEqual([]);
  });

  it("rejects an empty body with no eligible keys", async () => {
    const res = await PUT(req({ unrelated: 1 }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("no_settings_provided");
    expect(h.updates).toEqual([]);
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
    // source_revision comes from the updated row's updated_at, not Date.now().
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
