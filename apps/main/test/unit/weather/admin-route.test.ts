// §23.4 — GET/POST /api/admin/integrations/weather contract.
//
// Tests pin: auth gate (PlatformAdminError surfaces), GET aggregation
// (today / month / avg / chart), POST input validation (cap bounds),
// POST write goes through withPlatformAdminAudit (forensic record).

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
  return {
    ...actual,
    assertPlatformAdmin: vi.fn(async (req: Request) => {
      const adminUserId = req.headers.get("x-admin-user-id");
      if (!adminUserId) {
        throw new actual.PlatformAdminError(401, "missing_bearer", "Missing auth.");
      }
      return { admin_user_id: adminUserId, role: "test", via: "session" as const };
    }),
  };
});

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
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
  }),
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(async (opts: {
    admin_user_id: string; reason: string; operation: string; reason_detail: string;
  }, fn: (db: unknown, rec: () => void) => Promise<unknown>) => {
    mocks.auditCalls.push(opts);
    const db = {
      from: () => ({
        update: () => ({
          eq: async () => ({ error: mocks.updateError }),
        }),
      }),
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

  it("aggregates today / month / 7d-avg from historical rows", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    // Build 8 rows: 7 prior days + today. 7-day avg uses the 7 prior days.
    mocks.historyRows = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - (7 - i));
      return {
        metric_date: d.toISOString().slice(0, 10),
        requests_count: 100, // avg 100
        last_request_at: null,
      };
    });
    mocks.historyRows.push({ metric_date: today, requests_count: 42, last_request_at: null });
    // Ensure all rows are in this month so requests_this_month sums them all.
    mocks.historyRows = mocks.historyRows.filter((r) => r.metric_date.startsWith(month));

    const res = await GET(req("GET", undefined, { "x-admin-user-id": "u1" }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      cap: number; requests_today: number; requests_this_month: number; avg_7d: number;
    };
    expect(json.cap).toBe(8000);
    expect(json.requests_today).toBe(42);
    expect(json.avg_7d).toBe(100);
    expect(json.requests_this_month).toBe(100 * mocks.historyRows.filter((r) => r.metric_date !== today).length + 42);
  });

  it("returns 500 when cap read errors", async () => {
    mocks.capError = { message: "connection refused" };
    const res = await GET(req("GET", undefined, { "x-admin-user-id": "u1" }));
    expect(res.status).toBe(500);
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

  it("rejects cap > 10000 (above Open-Meteo ceiling)", async () => {
    const res = await POST(req("POST", { cap: 12000 }, { "x-admin-user-id": "u1" }));
    expect(res.status).toBe(400);
  });

  it("rejects non-integer cap", async () => {
    const res = await POST(req("POST", { cap: 1234.5 }, { "x-admin-user-id": "u1" }));
    expect(res.status).toBe(400);
  });

  it("writes through withPlatformAdminAudit with the right reason metadata", async () => {
    const res = await POST(req("POST", { cap: 5500 }, { "x-admin-user-id": "admin-42" }));
    expect(res.status).toBe(200);
    expect(mocks.auditCalls).toHaveLength(1);
    expect(mocks.auditCalls[0]).toMatchObject({
      admin_user_id: "admin-42",
      operation: "weather_daily_request_cap_update",
    });
    expect(mocks.auditCalls[0]?.reason_detail).toContain("5500");
  });
});
