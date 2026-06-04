// Issue #686 — enqueueEmbedding writes one pending_embedding row, generates
// a unique custom_id, and rejects empty content.

import { describe, expect, it, vi } from "vitest";
import { enqueueEmbedding } from "@/lib/embeddings/batch/enqueue";
import type { SupabaseClient } from "@supabase/supabase-js";

function mockDb(opts: { insertResult?: { data: unknown; error: unknown } } = {}) {
  const calls: Array<{ table: string; op: string; payload?: unknown }> = [];
  const result = opts.insertResult ?? {
    data: { id: "pending-row-id", custom_id: "custom-id-uuid" },
    error: null,
  };
  const db = {
    from(table: string) {
      return {
        insert(payload: unknown) {
          calls.push({ table, op: "insert", payload });
          return {
            select() {
              return { single: async () => result };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

describe("enqueueEmbedding", () => {
  it("inserts one row with a generated custom_id and returns ids", async () => {
    const { db, calls } = mockDb();
    const out = await enqueueEmbedding({ chunk_id: "chunk-1", content: "hello world", tenant_id: null, db });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.table).toBe("pending_embedding");
    const payload = calls[0]?.payload as Record<string, unknown>;
    expect(payload.chunk_id).toBe("chunk-1");
    expect(payload.content).toBe("hello world");
    expect(payload.status).toBe("pending");
    expect(payload.tenant_id).toBeNull();
    expect(typeof payload.custom_id).toBe("string");
    expect((payload.custom_id as string).length).toBeGreaterThan(8);
    expect(out.pending_id).toBe("pending-row-id");
  });

  it("persists tenant_id when provided (#689 attribution)", async () => {
    const { db, calls } = mockDb();
    await enqueueEmbedding({ chunk_id: "c", content: "x", tenant_id: "tenant-XYZ", db });
    expect((calls[0]?.payload as Record<string, unknown>).tenant_id).toBe("tenant-XYZ");
  });

  it("trims content before insert", async () => {
    const { db, calls } = mockDb();
    await enqueueEmbedding({ chunk_id: "c", content: "  trimmed  ", tenant_id: null, db });
    const payload = calls[0]?.payload as Record<string, unknown>;
    expect(payload.content).toBe("trimmed");
  });

  it("rejects empty content", async () => {
    const { db } = mockDb();
    await expect(
      enqueueEmbedding({ chunk_id: "c", content: "   ", tenant_id: null, db }),
    ).rejects.toThrow(/content is empty/);
  });

  it("rejects missing chunk_id", async () => {
    const { db } = mockDb();
    await expect(
      enqueueEmbedding({ chunk_id: "", content: "x", tenant_id: null, db }),
    ).rejects.toThrow(/chunk_id is required/);
  });

  it("surfaces Supabase errors as a structured throw", async () => {
    const { db } = mockDb({
      insertResult: {
        data: null,
        error: { message: "duplicate", code: "23505", hint: null, details: null, name: "Error" },
      },
    });
    await expect(
      enqueueEmbedding({ chunk_id: "c", content: "x", tenant_id: null, db }),
    ).rejects.toThrow(/pending_embedding\.insert/);
  });

  it("produces a unique custom_id across calls", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const { db, calls } = mockDb();
      await enqueueEmbedding({ chunk_id: `c${i}`, content: "x", tenant_id: null, db });
      const customId = (calls[0]?.payload as Record<string, unknown>).custom_id as string;
      expect(seen.has(customId)).toBe(false);
      seen.add(customId);
    }
  });
});
