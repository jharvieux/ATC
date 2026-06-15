// §23.4 — GET/POST /api/admin/integrations/weather contract.
//
// Tests pin: auth gate (PlatformAdminError surfaces), GET aggregation
// (today / month / avg / chart) wrapped in withPlatformAdminAudit, POST
// input validation (cap bounds tied to Open-Meteo free-tier ceiling),
// POST write failure surfaces as a thrown error, POST write goes through
// withPlatformAdminAudit (forensic record).

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  capValue: 8000 as unknown,
  capError: null as { message: string } | null,
  historyRows: [] as Array<{ metric_date: string; requests_count: number; last_request_at: string | null }>,
  historyError: null as { message: string } | null,
  updateError: null as { message: string } | null,
  auditCalls: [] as Array<{ admin_user_id: string; reason: string; operation: string; reason_detail: string }>,
}));

vi.mock("@/lib/auth/assert-platform-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-platform-admin")>(
    "@/lib/auth/assert-platform-admin",
  );
  const gate = async (req: Request) => {
    const adminUserId = req.headers.get("x-admin-user-id");
    if (!adminUserId) {
      throw new actual.PlatformAdminError(401, "missing_bearer", "Missing auth.");
    }
    return { admin_user_id: adminUserId, role: "superadmin" as const, via: "session" as const };
  };
  return {
    ...actual,
    assertPlatformAdmin: vi.fn(gate),
    assertPlatformRole: vi.fn(gate),
    assertPlatformAdminArea: vi.fn(gate),
  };
});

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(async (opts: {
    admin_user_id: string; reason: string; operation: string; reason_detail: string;
  }, fn: (db: unknown, rec: () => void) => Promise<unknown>) => {
    mocks.auditCalls.push(opts);
    const db = {
      from(table: string) {
        if (table === "platform_settings") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: mocks.capValue === undefined ? null : { value: mocks.capValue },
                  error: mocks.capError,
                }),
              }),
            }),
            update: () => ({
              eq: async () => ({ error: mocks.updateError }),
            }),
          };
        }
        if (table === "weather_usage_metrics") {
          return {
            select: () => ({
              gte: () => ({
                order: async () => ({ data: mocks.historyRows, error: mocks.historyError }),
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
    return fn(db, () => {});
  }),
}));

import { GET, POST } from "@/app/api/admin/integrations/weather/route";

function req(method: "GET" | "POST", body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = {
    method,
    headers: { "content-type": "application/json", ...headers },
  };
  if (body != null) init.body = JSON.stringify(body);
  return new Request("http://test/api/admin/integrations/weather", init);
}

beforeEach(() => {
  mocks.capValue = 8000;
  mocks.capError = null;
  mocks.historyRows = [];
  mocks.historyError = null;
  mocks.updateError = null;
  mocks.auditCalls = [];
});

describe("GET /api/admin/integrations/weather", () => {
  it("returns 401 without admin auth", async () => {
    const res = await GET(req("GET"));
    expect(res.status).toBe(401);
  });

  it("wraps the read in withPlatformAdminAudit (forensic record per §26.3a)", async () => {
    const res = await GET(req("GET", undefined, { "x-admin-user-id": "u1" }));
    expect(res.status).toBe(200);
    expect(mocks.auditCalls).toHaveLength(1);
    expect(mocks.auditCalls[0]).toMatchObject({
      admin_user_id: "u1",
      reason: "platform_metrics_rollup",
      operation: "weather_usage_read",
    });
  });

  it("aggregates today / month / 7d-avg from historical rows", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    mocks.historyRows = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - (7 - i));
      return {
        metric_date: d.toISOString().slice(0, 10),
        requests_count: 100,
        last_request_at: null,
      };
    });
    mocks.historyRows.push({ metric_date: today, requests_count: 42, last_request_at: null });
    // Do NOT filter mock rows by month — the mock represents the raw DB result
    // (last 30 days). The 7 prior-day rows may span a month boundary (e.g. when
    // running on the 1st); filtering them out here broke avg_7d on month start.
    // The route handles month filtering internally for requests_this_month.

    const res = await GET(req("GET", undefined, { "x-admin-user-id": "u1" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      cap: number; requests_today: number; requests_this_month: number; avg_7d: number;
    };
    expect(json.cap).toBe(8000);
    expect(json.requests_today).toBe(42);
    expect(json.avg_7d).toBe(100);
    const expectedMonthTotal = mocks.historyRows
      .filter((r) => r.metric_date.startsWith(month))
      .reduce((s, r) => s + r.requests_count, 0);
    expect(json.requests_this_month).toBe(expectedMonthTotal);
  });

  it("returns 500 when cap read errors", async () => {
    mocks.capError = { message: "connection refused" };
    const res = await GET(req("GET", undefined, { "x-admin-user-id": "u1" }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("cap_read_failed");
  });

  it("returns 500 when usage read errors", async () => {
    mocks.historyError = { message: "permission denied" };
    const res = await GET(req("GET", undefined, { "x-admin-user-id": "u1" }));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe("usage_read_failed");
  });
});

describe("POST /api/admin/integrations/weather", () => {
  it("returns 401 without admin auth", async () => {
    const res = await POST(req("POST", { cap: 5000 }));
    expect(res.status).toBe(401);
  });

  it("rejects invalid JSON", async () => {
    const r = new Request("http://test/x", {
      method: "POST",
      headers: { "x-admin-user-id": "u1", "content-type": "application/json" },
      body: "{",
    });
    const res = await POST(r);
    expect(res.status).toBe(400);
  });

  it("rejects cap = 0 (below floor)", async () => {
    const res = await POST(req("POST", { cap: 0 }, { "x-admin-user-id": "u1" }));
    expect(res.status).toBe(400);
  });

  it("rejects cap > 10000 (above Open-Meteo free-tier ceiling)", async () => {
    const res = await POST(req("POST", { cap: 12000 }, { "x-admin-user-id": "u1" }));
    expect(res.status).toBe(400);
  });

  it("rejects non-integer cap", async () => {
    const res = await POST(req("POST", { cap: 1234.5 }, { "x-admin-user-id": "u1" }));
    expect(res.status).toBe(400);
  });

  it("writes through withPlatformAdminAudit with platform_setting_update reason", async () => {
    const res = await POST(req("POST", { cap: 5500 }, { "x-admin-user-id": "admin-42" }));
    expect(res.status).toBe(200);
    expect(mocks.auditCalls).toHaveLength(1);
    expect(mocks.auditCalls[0]).toMatchObject({
      admin_user_id: "admin-42",
      reason: "platform_setting_update",
      operation: "weather_daily_request_cap_update",
    });
    expect(mocks.auditCalls[0]?.reason_detail).toContain("5500");
  });

  it("surfaces DB write failure as a thrown error (fail-loud, not silent)", async () => {
    mocks.updateError = { message: "row level security violation" };
    await expect(
      POST(req("POST", { cap: 5500 }, { "x-admin-user-id": "u1" })),
    ).rejects.toThrow(/platform_settings.update failed/);
  });
});
