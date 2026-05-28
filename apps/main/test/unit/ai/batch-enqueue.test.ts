// §27.12 — enqueueBatchRequest behavior tests.

import { describe, it, expect, vi } from "vitest";
import { enqueueBatchRequest } from "@/lib/ai/batch/enqueue";

const TENANT = "11111111-2222-3333-4444-555555555555";

function makeDb(opts: { insertedId?: string; insertError?: { message: string } } = {}) {
  const insertedId = opts.insertedId ?? "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const calls: Array<{ table: string; op: string; payload?: unknown }> = [];
  return {
    calls,
    client: {
      from(table: string) {
        return {
          insert(payload: unknown) {
            calls.push({ table, op: "insert", payload });
            return {
              select: () => ({
                single: async () => {
                  if (opts.insertError) return { data: null, error: opts.insertError };
                  return { data: { id: insertedId, custom_id: insertedId, created_at: "2026-05-28T00:00:00Z" }, error: null };
                },
              }),
            };
          },
          update(_payload: unknown) {
            calls.push({ table, op: "update", payload: _payload });
            return {
              eq: async () => ({ data: null, error: null }),
            };
          },
        };
      },
    },
  };
}

describe("enqueueBatchRequest", () => {
  it("rejects empty messages", async () => {
    const db = makeDb();
    await expect(
      enqueueBatchRequest({
        tenant_id: TENANT,
        purpose: "precruise_generation",
        request_params: { model: "claude-haiku-4-5", max_tokens: 100, messages: [] },
        db: db.client as never,
      }),
    ).rejects.toThrow(/messages array is empty/);
  });

  it("rejects non-positive max_tokens", async () => {
    const db = makeDb();
    await expect(
      enqueueBatchRequest({
        tenant_id: TENANT,
        purpose: "precruise_generation",
        request_params: {
          model: "claude-haiku-4-5",
          max_tokens: 0,
          messages: [{ role: "user", content: "x" }],
        },
        db: db.client as never,
      }),
    ).rejects.toThrow(/max_tokens/);
  });

  it("inserts a pending row + updates custom_id to id (round-trip)", async () => {
    const db = makeDb();
    const res = await enqueueBatchRequest({
      tenant_id: TENANT,
      purpose: "memory_extraction",
      request_params: {
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: "you are a CRM",
        messages: [{ role: "user", content: "extract" }],
      },
      caller_metadata: { conversation_id: "conv-1" },
      db: db.client as never,
    });
    expect(res.request_id).toBeTruthy();
    expect(res.enqueued_at).toMatch(/^2026/);

    // Expect: 1 insert + 1 update (for custom_id <- id).
    const inserts = db.calls.filter((c) => c.op === "insert");
    const updates = db.calls.filter((c) => c.op === "update");
    expect(inserts).toHaveLength(1);
    expect(updates).toHaveLength(1);

    // Insert payload carries tenant_id, purpose, status='pending',
    // request_params (as nested JSON), caller_metadata.
    const insertPayload = inserts[0]?.payload as {
      tenant_id: string;
      purpose: string;
      status: string;
      request_params: { model: string };
      caller_metadata: { conversation_id: string };
    };
    expect(insertPayload.tenant_id).toBe(TENANT);
    expect(insertPayload.purpose).toBe("memory_extraction");
    expect(insertPayload.status).toBe("pending");
    expect(insertPayload.request_params.model).toBe("claude-haiku-4-5");
    expect(insertPayload.caller_metadata.conversation_id).toBe("conv-1");

    // Update payload sets custom_id = id (a UUID).
    const updatePayload = updates[0]?.payload as { custom_id: string };
    expect(updatePayload.custom_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("surfaces a DB insert error as a structured throw (D-094)", async () => {
    const db = makeDb({ insertError: { message: "tenant FK violation" } });
    await expect(
      enqueueBatchRequest({
        tenant_id: TENANT,
        purpose: "precruise_generation",
        request_params: {
          model: "claude-haiku-4-5",
          max_tokens: 100,
          messages: [{ role: "user", content: "x" }],
        },
        db: db.client as never,
      }),
    ).rejects.toThrow(/tenant FK violation/);
  });

  it("allows omitting caller_metadata", async () => {
    const db = makeDb();
    await enqueueBatchRequest({
      tenant_id: TENANT,
      purpose: "rag_normalization",
      request_params: {
        model: "claude-haiku-4-5",
        max_tokens: 200,
        messages: [{ role: "user", content: "x" }],
      },
      db: db.client as never,
    });
    const insertPayload = db.calls[0]?.payload as { caller_metadata: unknown };
    expect(insertPayload.caller_metadata).toBeNull();
  });
});
