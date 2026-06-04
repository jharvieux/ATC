// Issue #689 — fault-tolerance contract for fetchRagEmbeddingRows.
//
// The dashboard route loads rag_ai_call_log to surface embedding cost.
// When the rag DB is unreachable (or its env vars unset), the dashboard
// MUST still render main-side data — embedding cost just zeroes out for
// that render. These tests pin that contract so a refactor that turns
// the rag-side failure into a 500 will fail loudly.

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("fetchRagEmbeddingRows fault-tolerance", () => {
  it("returns empty maps when the rag client throws on init (e.g. env missing)", async () => {
    vi.doMock("@/lib/db/rag-read", () => ({
      getRagReadClient: () => {
        throw new Error("SUPABASE_RAG_URL not set");
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchRagEmbeddingRows } = await import("@/app/api/admin/resource-utilization/rag-fetch");
    const out = await fetchRagEmbeddingRows("2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z");
    expect(out.daily).toEqual([]);
    expect(out.byModel).toEqual([]);
    expect(out.tenantPeriod.size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("returns empty maps when the rag query returns a Supabase error", async () => {
    vi.doMock("@/lib/db/rag-read", () => ({
      getRagReadClient: () => ({
        from: () => ({
          select: () => ({
            gte: () => ({
              not: () => Promise.resolve({ data: null, error: { message: "connection refused" } }),
              then: (resolve: (v: { data: null; error: { message: string } }) => void) =>
                resolve({ data: null, error: { message: "connection refused" } }),
            }),
          }),
        }),
      }),
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchRagEmbeddingRows } = await import("@/app/api/admin/resource-utilization/rag-fetch");
    const out = await fetchRagEmbeddingRows("2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z");
    expect(out.daily).toEqual([]);
    expect(out.byModel).toEqual([]);
    expect(out.tenantPeriod.size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("aggregates tenantPeriod cost by tenant_id when rag is reachable", async () => {
    const dailyData = [{ created_at: "2026-06-01T00:00:00Z", cost_estimate_cents: 10 }];
    const modelData = [
      { vendor: "openai", model: "text-embedding-3-small", input_tokens: 1000, output_tokens: 0, cost_estimate_cents: 10 },
    ];
    const tenantData = [
      { tenant_id: "tenant-A", cost_estimate_cents: 25 },
      { tenant_id: "tenant-A", cost_estimate_cents: 75 },
      { tenant_id: "tenant-B", cost_estimate_cents: 40 },
    ];

    // Discriminate the three queries by their second selected column: the
    // daily query selects "created_at, cost_estimate_cents", model selects
    // "vendor, model, ...", and tenant selects "tenant_id, cost_estimate_cents".
    vi.doMock("@/lib/db/rag-read", () => ({
      getRagReadClient: () => ({
        from: () => ({
          select: (cols: string) => {
            const result = cols.startsWith("tenant_id")
              ? { data: tenantData, error: null }
              : cols.startsWith("vendor")
                ? { data: modelData, error: null }
                : { data: dailyData, error: null };
            return {
              gte: () => ({
                not: () => Promise.resolve(result),
                then: (resolve: (v: typeof result) => void) => resolve(result),
              }),
            };
          },
        }),
      }),
    }));
    const { fetchRagEmbeddingRows } = await import("@/app/api/admin/resource-utilization/rag-fetch");
    const out = await fetchRagEmbeddingRows("2026-05-01T00:00:00Z", "2026-06-01T00:00:00Z");
    expect(out.tenantPeriod.get("tenant-A")).toBe(100);
    expect(out.tenantPeriod.get("tenant-B")).toBe(40);
    expect(out.daily).toHaveLength(1);
    expect(out.byModel).toHaveLength(1);
  });
});

describe("periodStartIso", () => {
  it("parses a Postgres range literal lower bound", async () => {
    const { periodStartIso } = await import("@/app/api/admin/resource-utilization/rag-fetch");
    expect(periodStartIso("[2026-06-01,2026-07-01)")).toBe("2026-06-01T00:00:00Z");
  });

  it("falls back to current-month UTC start when shape is unexpected", async () => {
    const { periodStartIso } = await import("@/app/api/admin/resource-utilization/rag-fetch");
    const out = periodStartIso("garbage");
    expect(out).toMatch(/^\d{4}-\d{2}-01T00:00:00\.\d+Z$/);
  });
});
