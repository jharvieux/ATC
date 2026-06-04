// Unit tests for /api/admin/resource-utilization — §resources dashboard.
//
// Part 1: pure aggregation helpers (no mocks) — parseBigIntCol, buildDailyArray,
//   aggregateByModel, sortTenantsByProximity.
// Part 2: PUT handler — validation rules and 401 rejection path.

import { describe, it, expect, vi } from "vitest";

// ── Part 1: pure helpers ──────────────────────────────────────────────────────

describe("parseBigIntCol", () => {
  it("passes JS numbers through unchanged", async () => {
    const { parseBigIntCol } = await import("@/app/api/admin/resource-utilization/aggregations");
    expect(parseBigIntCol(0)).toBe(0);
    expect(parseBigIntCol(42)).toBe(42);
    expect(parseBigIntCol(9007199254740991)).toBe(9007199254740991);
  });

  it("parses Supabase-style BIGINT strings", async () => {
    const { parseBigIntCol } = await import("@/app/api/admin/resource-utilization/aggregations");
    expect(parseBigIntCol("123")).toBe(123);
    expect(parseBigIntCol("0")).toBe(0);
    expect(parseBigIntCol("9999999")).toBe(9999999);
  });

  it("returns 0 for null, undefined, and non-numeric strings", async () => {
    const { parseBigIntCol } = await import("@/app/api/admin/resource-utilization/aggregations");
    expect(parseBigIntCol(null)).toBe(0);
    expect(parseBigIntCol(undefined)).toBe(0);
    expect(parseBigIntCol("not-a-number")).toBe(0);
    expect(parseBigIntCol("")).toBe(0);
  });
});

describe("buildDailyArray", () => {
  it("always returns exactly 30 entries regardless of data density", async () => {
    const { buildDailyArray } = await import("@/app/api/admin/resource-utilization/aggregations");
    const daily = buildDailyArray([], [], [], new Date("2024-03-15"));
    expect(daily).toHaveLength(30);
  });

  it("last entry is the today date, first is 29 days earlier", async () => {
    const { buildDailyArray } = await import("@/app/api/admin/resource-utilization/aggregations");
    const today = new Date("2024-03-15T12:00:00Z");
    const daily = buildDailyArray([], [], [], today);
    expect(daily[29]!.date).toBe("2024-03-15");
    expect(daily[0]!.date).toBe("2024-02-15");
  });

  it("zero-fills days with no activity", async () => {
    const { buildDailyArray } = await import("@/app/api/admin/resource-utilization/aggregations");
    const daily = buildDailyArray([], [], [], new Date("2024-03-15"));
    for (const row of daily) {
      expect(row.ai_cost_cents).toBe(0);
      expect(row.email_count).toBe(0);
      expect(row.weather_requests).toBe(0);
    }
  });

  it("buckets AI costs by day and aggregates multiple rows on the same day", async () => {
    const { buildDailyArray } = await import("@/app/api/admin/resource-utilization/aggregations");
    const today = new Date("2024-03-15");
    const daily = buildDailyArray(
      [
        { created_at: "2024-03-15T09:00:00Z", cost_estimate_cents: 100 },
        { created_at: "2024-03-15T11:00:00Z", cost_estimate_cents: "250" },
        { created_at: "2024-03-14T08:00:00Z", cost_estimate_cents: 75 },
      ],
      [],
      [],
      today,
    );
    const mar15 = daily.find((d) => d.date === "2024-03-15")!;
    const mar14 = daily.find((d) => d.date === "2024-03-14")!;
    expect(mar15.ai_cost_cents).toBe(350);
    expect(mar14.ai_cost_cents).toBe(75);
  });

  it("counts emails per day and skips null sent_at", async () => {
    const { buildDailyArray } = await import("@/app/api/admin/resource-utilization/aggregations");
    const today = new Date("2024-03-15");
    const daily = buildDailyArray(
      [],
      [
        { sent_at: "2024-03-15T10:00:00Z" },
        { sent_at: "2024-03-15T14:00:00Z" },
        { sent_at: null },
        { sent_at: "2024-03-14T10:00:00Z" },
      ],
      [],
      today,
    );
    expect(daily.find((d) => d.date === "2024-03-15")!.email_count).toBe(2);
    expect(daily.find((d) => d.date === "2024-03-14")!.email_count).toBe(1);
  });

  it("maps weather requests by metric_date", async () => {
    const { buildDailyArray } = await import("@/app/api/admin/resource-utilization/aggregations");
    const today = new Date("2024-03-15");
    const daily = buildDailyArray([], [], [{ metric_date: "2024-03-13", requests_count: 42 }], today);
    expect(daily.find((d) => d.date === "2024-03-13")!.weather_requests).toBe(42);
  });
});

describe("aggregateByModel", () => {
  it("returns empty array for empty input", async () => {
    const { aggregateByModel } = await import("@/app/api/admin/resource-utilization/aggregations");
    expect(aggregateByModel([])).toEqual([]);
  });

  it("merges multiple calls for the same vendor:model key", async () => {
    const { aggregateByModel } = await import("@/app/api/admin/resource-utilization/aggregations");
    const rows = [
      { vendor: "anthropic", model: "claude-sonnet-4-6", input_tokens: 100, output_tokens: 50, cost_estimate_cents: 10 },
      { vendor: "anthropic", model: "claude-sonnet-4-6", input_tokens: 200, output_tokens: 80, cost_estimate_cents: 20 },
    ];
    const result = aggregateByModel(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      vendor: "anthropic",
      model: "claude-sonnet-4-6",
      call_count: 2,
      input_tokens: 300,
      output_tokens: 130,
      cost_cents: 30,
    });
  });

  it("keeps distinct vendor:model pairs separate", async () => {
    const { aggregateByModel } = await import("@/app/api/admin/resource-utilization/aggregations");
    const rows = [
      { vendor: "anthropic", model: "claude-opus-4-7", input_tokens: 100, output_tokens: 50, cost_estimate_cents: 100 },
      { vendor: "openai", model: "gpt-4o", input_tokens: 80, output_tokens: 40, cost_estimate_cents: 60 },
    ];
    expect(aggregateByModel(rows)).toHaveLength(2);
  });

  it("merges rag embedding rows alongside main chat rows (#689 dashboard integration)", async () => {
    const { aggregateByModel } = await import("@/app/api/admin/resource-utilization/aggregations");
    // Simulates the route merging main ai_call_log + rag rag_ai_call_log
    // into one rowset before aggregation. The dashboard's "AI by model"
    // table should show the embedding model as its own row.
    const merged = [
      { vendor: "anthropic", model: "claude-sonnet-4-6", input_tokens: 1000, output_tokens: 500, cost_estimate_cents: 100 },
      { vendor: "openai", model: "text-embedding-3-small", input_tokens: 500_000, output_tokens: 0, cost_estimate_cents: 100 },
      { vendor: "openai", model: "text-embedding-3-small", input_tokens: 1_500_000, output_tokens: 0, cost_estimate_cents: 300 },
    ];
    const result = aggregateByModel(merged);
    expect(result).toHaveLength(2);
    const embedRow = result.find((r) => r.model === "text-embedding-3-small");
    expect(embedRow).toBeDefined();
    expect(embedRow!.vendor).toBe("openai");
    expect(embedRow!.call_count).toBe(2);
    expect(embedRow!.input_tokens).toBe(2_000_000);
    expect(embedRow!.output_tokens).toBe(0);
    expect(embedRow!.cost_cents).toBe(400);
  });

  it("sorts by cost_cents descending", async () => {
    const { aggregateByModel } = await import("@/app/api/admin/resource-utilization/aggregations");
    const rows = [
      { vendor: "openai", model: "gpt-4o", input_tokens: 10, output_tokens: 5, cost_estimate_cents: 30 },
      { vendor: "anthropic", model: "claude-opus-4-7", input_tokens: 100, output_tokens: 50, cost_estimate_cents: 100 },
      { vendor: "anthropic", model: "claude-haiku-4-5-20251001", input_tokens: 50, output_tokens: 25, cost_estimate_cents: 5 },
    ];
    const result = aggregateByModel(rows);
    expect(result[0]!.cost_cents).toBeGreaterThanOrEqual(result[1]!.cost_cents);
    expect(result[1]!.cost_cents).toBeGreaterThanOrEqual(result[2]!.cost_cents);
  });

  it("handles BigInt-string cost_estimate_cents", async () => {
    const { aggregateByModel } = await import("@/app/api/admin/resource-utilization/aggregations");
    const rows = [
      { vendor: "anthropic", model: "claude-sonnet-4-6", input_tokens: 100, output_tokens: 50, cost_estimate_cents: "9999" },
    ];
    expect(aggregateByModel(rows)[0]!.cost_cents).toBe(9999);
  });
});

describe("sortTenantsByProximity", () => {
  it("returns empty array for empty input", async () => {
    const { sortTenantsByProximity } = await import("@/app/api/admin/resource-utilization/aggregations");
    expect(sortTenantsByProximity([])).toEqual([]);
  });

  it("orders by limit state severity: hard > soft2 > soft1 > ok", async () => {
    const { sortTenantsByProximity } = await import("@/app/api/admin/resource-utilization/aggregations");
    const tenants = [
      { tenant_id: "c", slug: "c", display_name: "C", ai_cost_cents: 100, ai_cost_limit_state: "ok", email_sent_count: 0, email_volume_limit_state: "ok" },
      { tenant_id: "a", slug: "a", display_name: "A", ai_cost_cents: 100, ai_cost_limit_state: "hard", email_sent_count: 0, email_volume_limit_state: "ok" },
      { tenant_id: "b", slug: "b", display_name: "B", ai_cost_cents: 100, ai_cost_limit_state: "soft1", email_sent_count: 0, email_volume_limit_state: "ok" },
      { tenant_id: "d", slug: "d", display_name: "D", ai_cost_cents: 100, ai_cost_limit_state: "soft2", email_sent_count: 0, email_volume_limit_state: "ok" },
    ];
    const sorted = sortTenantsByProximity(tenants);
    expect(sorted.map((t) => t.ai_cost_limit_state)).toEqual(["hard", "soft2", "soft1", "ok"]);
  });

  it("within same state, sorts by ai_cost_cents descending", async () => {
    const { sortTenantsByProximity } = await import("@/app/api/admin/resource-utilization/aggregations");
    const tenants = [
      { tenant_id: "x", slug: "x", display_name: "X", ai_cost_cents: 500, ai_cost_limit_state: "soft1", email_sent_count: 0, email_volume_limit_state: "ok" },
      { tenant_id: "y", slug: "y", display_name: "Y", ai_cost_cents: 1000, ai_cost_limit_state: "soft1", email_sent_count: 0, email_volume_limit_state: "ok" },
      { tenant_id: "z", slug: "z", display_name: "Z", ai_cost_cents: 200, ai_cost_limit_state: "soft1", email_sent_count: 0, email_volume_limit_state: "ok" },
    ];
    const sorted = sortTenantsByProximity(tenants);
    expect(sorted.map((t) => t.ai_cost_cents)).toEqual([1000, 500, 200]);
  });

  it("does not mutate the input array", async () => {
    const { sortTenantsByProximity } = await import("@/app/api/admin/resource-utilization/aggregations");
    const tenants = [
      { tenant_id: "a", slug: "a", display_name: "A", ai_cost_cents: 100, ai_cost_limit_state: "hard", email_sent_count: 0, email_volume_limit_state: "ok" },
      { tenant_id: "b", slug: "b", display_name: "B", ai_cost_cents: 200, ai_cost_limit_state: "ok", email_sent_count: 0, email_volume_limit_state: "ok" },
    ];
    const original = [...tenants];
    sortTenantsByProximity(tenants);
    expect(tenants).toEqual(original);
  });
});

describe("aggregateApifyByCruiseLine", () => {
  it("returns empty array for empty input", async () => {
    const { aggregateApifyByCruiseLine } = await import("@/app/api/admin/resource-utilization/aggregations");
    expect(aggregateApifyByCruiseLine([])).toEqual([]);
  });

  it("groups rows by cruise_line and sums spend_usd", async () => {
    const { aggregateApifyByCruiseLine } = await import("@/app/api/admin/resource-utilization/aggregations");
    const rows = [
      { cruise_line: "RCL", spend_usd: 1.5 },
      { cruise_line: "RCL", spend_usd: 2.0 },
      { cruise_line: "CCL", spend_usd: 0.5 },
    ];
    const result = aggregateApifyByCruiseLine(rows);
    const rcl = result.find((r) => r.cruise_line === "RCL")!;
    expect(rcl.run_count).toBe(2);
    expect(rcl.spend_usd).toBeCloseTo(3.5);
    expect(result.find((r) => r.cruise_line === "CCL")!.run_count).toBe(1);
  });

  it("treats null cruise_line as its own bucket", async () => {
    const { aggregateApifyByCruiseLine } = await import("@/app/api/admin/resource-utilization/aggregations");
    const rows = [
      { cruise_line: null, spend_usd: 1.0 },
      { cruise_line: null, spend_usd: 2.0 },
    ];
    const result = aggregateApifyByCruiseLine(rows);
    expect(result).toHaveLength(1);
    expect(result[0]!.cruise_line).toBeNull();
    expect(result[0]!.run_count).toBe(2);
  });

  it("sorts by spend_usd descending", async () => {
    const { aggregateApifyByCruiseLine } = await import("@/app/api/admin/resource-utilization/aggregations");
    const rows = [
      { cruise_line: "NCL", spend_usd: 0.5 },
      { cruise_line: "RCL", spend_usd: 5.0 },
      { cruise_line: "CCL", spend_usd: 2.0 },
    ];
    const result = aggregateApifyByCruiseLine(rows);
    expect(result[0]!.spend_usd).toBeGreaterThanOrEqual(result[1]!.spend_usd);
    expect(result[1]!.spend_usd).toBeGreaterThanOrEqual(result[2]!.spend_usd);
  });
});

describe("buildDailyArray with apify rows", () => {
  it("buckets apify spend by invoked_at day, converting USD to cents", async () => {
    const { buildDailyArray } = await import("@/app/api/admin/resource-utilization/aggregations");
    const today = new Date("2024-03-15");
    const daily = buildDailyArray(
      [],
      [],
      [],
      today,
      [
        { invoked_at: "2024-03-15T10:00:00Z", spend_usd: 1.5 },
        { invoked_at: "2024-03-15T14:00:00Z", spend_usd: 0.5 },
        { invoked_at: "2024-03-14T08:00:00Z", spend_usd: 2.0 },
      ],
    );
    expect(daily.find((d) => d.date === "2024-03-15")!.apify_spend_cents).toBe(200);
    expect(daily.find((d) => d.date === "2024-03-14")!.apify_spend_cents).toBe(200);
  });

  it("zero-fills apify_spend_cents when no apify rows provided", async () => {
    const { buildDailyArray } = await import("@/app/api/admin/resource-utilization/aggregations");
    const daily = buildDailyArray([], [], [], new Date("2024-03-15"));
    for (const row of daily) {
      expect(row.apify_spend_cents).toBe(0);
    }
  });
});

// ── Part 2: PUT handler ───────────────────────────────────────────────────────

vi.mock("@/lib/auth/assert-platform-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-platform-admin")>(
    "@/lib/auth/assert-platform-admin",
  );
  return {
    ...actual,
    assertPlatformAdmin: vi.fn(async (req: Request) => {
      const id = req.headers.get("x-admin-user-id");
      if (!id) throw new actual.PlatformAdminError(401, "missing_bearer", "Missing auth.");
      return { admin_user_id: id, role: "test", via: "session" as const };
    }),
  };
});

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(async (_opts: unknown, fn: (db: unknown, rq: unknown) => Promise<unknown>) =>
    fn({ from: () => ({ upsert: () => Promise.resolve({ error: null, data: null }) }) }, () => {}),
  ),
}));

function putReq(body: unknown, adminId?: string): Request {
  return new Request("http://test/api/admin/resource-utilization", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(adminId ? { "x-admin-user-id": adminId } : {}) },
    body: JSON.stringify(body),
  });
}

describe("PUT /api/admin/resource-utilization", () => {
  it("returns 401 when admin auth is absent", async () => {
    const { PUT } = await import("@/app/api/admin/resource-utilization/route");
    const res = await PUT(putReq({ resend_cost_per_email_cents: 19 }));
    expect(res.status).toBe(401);
  });

  it("returns 400 for negative value", async () => {
    const { PUT } = await import("@/app/api/admin/resource-utilization/route");
    const res = await PUT(putReq({ resend_cost_per_email_cents: -1 }, "admin-123"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("non-negative") });
  });

  it("returns 400 for Infinity", async () => {
    const { PUT } = await import("@/app/api/admin/resource-utilization/route");
    const res = await PUT(putReq({ resend_cost_per_email_cents: Infinity }, "admin-123"));
    expect(res.status).toBe(400);
  });

  it("returns 400 when value is a string", async () => {
    const { PUT } = await import("@/app/api/admin/resource-utilization/route");
    const res = await PUT(putReq({ resend_cost_per_email_cents: "19" }, "admin-123"));
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const { PUT } = await import("@/app/api/admin/resource-utilization/route");
    const req = new Request("http://test/api/admin/resource-utilization", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-admin-user-id": "admin-123" },
      body: "not-json{{{",
    });
    const res = await PUT(req);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_json" });
  });

  it("returns 200 with ok:true for a valid non-negative value", async () => {
    const { PUT } = await import("@/app/api/admin/resource-utilization/route");
    const res = await PUT(putReq({ resend_cost_per_email_cents: 19 }, "admin-123"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, resend_rate: 19 });
  });

  it("accepts 0 as a valid value (free tier / override)", async () => {
    const { PUT } = await import("@/app/api/admin/resource-utilization/route");
    const res = await PUT(putReq({ resend_cost_per_email_cents: 0 }, "admin-123"));
    expect(res.status).toBe(200);
  });

  it("returns 400 for empty body (no recognized fields)", async () => {
    const { PUT } = await import("@/app/api/admin/resource-utilization/route");
    const res = await PUT(putReq({}, "admin-123"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "no_recognized_fields" });
  });
});

describe("PUT /api/admin/resource-utilization — apify budget", () => {
  it("returns 200 with ok:true for a valid positive budget", async () => {
    const { PUT } = await import("@/app/api/admin/resource-utilization/route");
    const res = await PUT(putReq({ apify_monthly_budget_usd: 500 }, "admin-123"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, apify_monthly_budget_usd: 500 });
  });

  it("returns 400 for zero budget", async () => {
    const { PUT } = await import("@/app/api/admin/resource-utilization/route");
    const res = await PUT(putReq({ apify_monthly_budget_usd: 0 }, "admin-123"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("positive") });
  });

  it("returns 400 for negative budget", async () => {
    const { PUT } = await import("@/app/api/admin/resource-utilization/route");
    const res = await PUT(putReq({ apify_monthly_budget_usd: -100 }, "admin-123"));
    expect(res.status).toBe(400);
  });

  it("accepts both fields in one request", async () => {
    const { PUT } = await import("@/app/api/admin/resource-utilization/route");
    const res = await PUT(putReq({ resend_cost_per_email_cents: 19, apify_monthly_budget_usd: 250 }, "admin-123"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, resend_rate: 19, apify_monthly_budget_usd: 250 });
  });
});
