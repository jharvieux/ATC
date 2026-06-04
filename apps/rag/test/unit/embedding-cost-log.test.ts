// Issue #689 — cost-log helper and per-model rate math.

import { describe, expect, it, vi } from "vitest";
import { estimateEmbeddingCostCents, logEmbeddingCall } from "@/lib/embeddings/cost-log";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("estimateEmbeddingCostCents", () => {
  it("text-embedding-3-small: 200 cents/M = 0 for sub-5000 token call", () => {
    expect(estimateEmbeddingCostCents("text-embedding-3-small", 100)).toBe(0);
    expect(estimateEmbeddingCostCents("text-embedding-3-small", 4999)).toBe(0);
  });

  it("text-embedding-3-small: 5000 tokens × 200/M = 1 cent", () => {
    expect(estimateEmbeddingCostCents("text-embedding-3-small", 5000)).toBe(1);
  });

  it("text-embedding-3-small: 1M tokens × 200/M = 200 cents", () => {
    expect(estimateEmbeddingCostCents("text-embedding-3-small", 1_000_000)).toBe(200);
  });

  it("text-embedding-3-large: 1M tokens × 1300/M = 1300 cents", () => {
    expect(estimateEmbeddingCostCents("text-embedding-3-large", 1_000_000)).toBe(1300);
  });

  it("unknown model: $0", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(estimateEmbeddingCostCents("gpt-future", 1_000_000)).toBe(0);
    spy.mockRestore();
  });

  it("negative token count clamped to 0", () => {
    expect(estimateEmbeddingCostCents("text-embedding-3-small", -5)).toBe(0);
  });
});

describe("logEmbeddingCall", () => {
  function mockDb(): { db: SupabaseClient; calls: Array<{ table: string; payload: Record<string, unknown> }> } {
    const calls: Array<{ table: string; payload: Record<string, unknown> }> = [];
    const db = {
      from(table: string) {
        return {
          insert(payload: Record<string, unknown>) {
            calls.push({ table, payload });
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    } as unknown as SupabaseClient;
    return { db, calls };
  }

  it("writes one row with computed cost", async () => {
    const { db, calls } = mockDb();
    await logEmbeddingCall({
      db,
      tenant_id: "tenant-1",
      model: "text-embedding-3-small",
      source: "batch",
      input_tokens: 1_000_000,
      latency_ms: 4321,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.table).toBe("rag_ai_call_log");
    const p = calls[0]?.payload as Record<string, unknown>;
    expect(p.tenant_id).toBe("tenant-1");
    expect(p.vendor).toBe("openai");
    expect(p.purpose).toBe("embedding");
    expect(p.source).toBe("batch");
    expect(p.cost_estimate_cents).toBe(200);
    expect(p.input_tokens).toBe(1_000_000);
    expect(p.latency_ms).toBe(4321);
  });

  it("accepts null tenant_id (platform-eaten cost)", async () => {
    const { db, calls } = mockDb();
    await logEmbeddingCall({
      db,
      tenant_id: null,
      model: "text-embedding-3-small",
      source: "sync",
      input_tokens: 100,
    });
    expect((calls[0]?.payload as Record<string, unknown>).tenant_id).toBeNull();
    expect((calls[0]?.payload as Record<string, unknown>).source).toBe("sync");
  });

  it("surfaces Supabase errors as a thrown structured error", async () => {
    const db = {
      from() {
        return {
          insert() {
            return Promise.resolve({
              data: null,
              error: { message: "rls denied", code: "42501", hint: null, details: null, name: "Error" },
            });
          },
        };
      },
    } as unknown as SupabaseClient;
    await expect(
      logEmbeddingCall({ db, tenant_id: null, model: "text-embedding-3-small", source: "sync", input_tokens: 1 }),
    ).rejects.toThrow(/rag_ai_call_log\.insert/);
  });
});
