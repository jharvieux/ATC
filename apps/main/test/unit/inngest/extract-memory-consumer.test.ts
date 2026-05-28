// §27.12 — applyExtractedMemory (batch consumer) behavior tests.
//
// Covers the path that moved out of runExtractMemory into the consumer
// when the batch migration landed: parse + zod validate + re-load
// memory row + merge + optimistic-lock write + audit.

import { describe, it, expect, vi } from "vitest";
import { applyExtractedMemory } from "@/inngest/extract-memory";
import type { SupabaseClient } from "@supabase/supabase-js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const USER = "99999999-8888-7777-6666-555555555555";
const CONV = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NOW_ISO = "2026-05-28T08:00:00Z";
const OLD_ISO = "2026-05-28T07:00:00Z";

vi.mock("@/lib/audit/write", () => ({
  writeAuditLog: async () => undefined,
}));

interface MockStep {
  run<T>(_id: string, fn: () => Promise<T>): Promise<T>;
  sleep(_id: string, _ms: number): Promise<void>;
  sendEvent(_id: string, _events: unknown): Promise<void>;
  sleptMs: number[];
  sentEvents: unknown[];
}

function makeStep(): MockStep {
  const sleptMs: number[] = [];
  const sentEvents: unknown[] = [];
  return {
    async run<T>(_id: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },
    async sleep(_id: string, ms: number): Promise<void> {
      sleptMs.push(ms);
    },
    async sendEvent(_id: string, events: unknown): Promise<void> {
      sentEvents.push(events);
    },
    sleptMs,
    sentEvents,
  };
}

function makeDb(opts: {
  memoryRow?: Record<string, unknown> | null;
  updateRows?: Array<{ id: string }>;
  conversation?: { id: string; user_id: string; status: string } | null;
}) {
  const memoryRow = opts.memoryRow ?? null;
  const updateRows = opts.updateRows ?? [{ id: "mem-uuid" }];
  const conversation =
    opts.conversation ?? { id: CONV, user_id: USER, status: "closed" };
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];

  return {
    db: {
      from(table: string) {
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: conversation, error: null }),
              }),
            }),
          };
        }
        if (table === "customer_memories") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: memoryRow, error: null }),
              }),
            }),
            update: (patch: Record<string, unknown>) => {
              updates.push(patch);
              return {
                eq: () => ({
                  eq: () => ({
                    select: () => ({ data: updateRows, error: null }),
                  }),
                }),
              };
            },
            insert: async (row: Record<string, unknown>) => {
              inserts.push(row);
              return { data: null, error: null };
            },
          };
        }
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      },
    } as unknown as SupabaseClient,
    inserts,
    updates,
  };
}

describe("applyExtractedMemory — invalid response", () => {
  it("returns invalid_response on unparseable JSON", async () => {
    const { db } = makeDb({});
    const result = await applyExtractedMemory({
      tenant_id: TENANT,
      conversation_id: CONV,
      user_id: USER,
      result_text: "not json at all",
      db,
      step: makeStep(),
    });
    expect(result.status).toBe("invalid_response");
  });

  it("returns invalid_response when JSON fails Zod schema", async () => {
    const { db } = makeDb({});
    const result = await applyExtractedMemory({
      tenant_id: TENANT,
      conversation_id: CONV,
      user_id: USER,
      result_text: '{"rapport_tone_level": 99}', // out of 1-5 range
      db,
      step: makeStep(),
    });
    expect(result.status).toBe("invalid_response");
  });
});

describe("applyExtractedMemory — scope assertion", () => {
  it("throws when conversation.user_id does not match caller_metadata.user_id", async () => {
    const { db } = makeDb({
      conversation: { id: CONV, user_id: "different-user", status: "active" },
    });
    await expect(
      applyExtractedMemory({
        tenant_id: TENANT,
        conversation_id: CONV,
        user_id: USER,
        result_text: '{"notes_freeform":"x"}',
        db,
        step: makeStep(),
      }),
    ).rejects.toThrow(/SCOPE ASSERTION FAILED/);
  });
});

describe("applyExtractedMemory — first-extraction (INSERT path)", () => {
  it("inserts a new customer_memories row when none exists", async () => {
    const { db, inserts } = makeDb({ memoryRow: null });
    const result = await applyExtractedMemory({
      tenant_id: TENANT,
      conversation_id: CONV,
      user_id: USER,
      result_text: '{"notes_freeform":"loves ocean views"}',
      db,
      step: makeStep(),
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.extracted_fields).toContain("notes_freeform");
    }
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.user_id).toBe(USER);
    expect(inserts[0]?.notes_freeform).toBe("loves ocean views");
  });
});

describe("applyExtractedMemory — UPDATE path (memory row exists)", () => {
  it("updates with optimistic-lock guard on updated_at", async () => {
    const { db, updates } = makeDb({
      memoryRow: { id: "mem-1", user_id: USER, updated_at: OLD_ISO },
    });
    const result = await applyExtractedMemory({
      tenant_id: TENANT,
      conversation_id: CONV,
      user_id: USER,
      result_text: '{"notes_freeform":"updated note"}',
      db,
      step: makeStep(),
    });
    expect(result.status).toBe("ok");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.notes_freeform).toBe("updated note");
    expect(updates[0]?.last_extracted_at).toBeDefined();
  });
});

describe("applyExtractedMemory — optimistic lock conflict", () => {
  it("requeues when UPDATE returns zero rows (concurrent write detected)", async () => {
    process.env.MEMORY_EXTRACTION_RETRY_DELAY_MS = "5000";
    const { db } = makeDb({
      memoryRow: { id: "mem-1", user_id: USER, updated_at: OLD_ISO },
      updateRows: [], // concurrent writer won
    });
    const step = makeStep();
    const result = await applyExtractedMemory({
      tenant_id: TENANT,
      conversation_id: CONV,
      user_id: USER,
      result_text: '{"notes_freeform":"x"}',
      db,
      step,
    });
    expect(result.status).toBe("requeued_optimistic_lock_conflict");
    expect(step.sleptMs).toEqual([5000]);
    expect(step.sentEvents).toHaveLength(1);
  });
});

void NOW_ISO; // silence unused-warning in case Date.now() drifts
