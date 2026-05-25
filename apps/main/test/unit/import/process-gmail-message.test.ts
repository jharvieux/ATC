// BP34 §34.2 — Gmail message → import pipeline glue tests.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processGmailInboundMessage } from "@/lib/import/process-gmail-message";

// Stub inngest.send so we can assert it was called without hitting the real
// client.
vi.mock("@/inngest/client", () => ({
  inngest: { send: vi.fn(async () => undefined) },
}));

import { inngest } from "@/inngest/client";

function fakeSvc(opts?: { insertId?: string }) {
  const updates: Array<{ table: string; payload: unknown; where: unknown }> = [];
  const inserts: Array<{ table: string; payload: unknown }> = [];
  return {
    updates,
    inserts,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    svc: {
      from: (table: string) => ({
        update: (payload: unknown) => ({
          eq: (_col: string, val: unknown) => {
            updates.push({ table, payload, where: val });
            return Promise.resolve({ data: null, error: null });
          },
        }),
        insert: (payload: unknown) => ({
          select: () => ({
            single: () => {
              inserts.push({ table, payload });
              return Promise.resolve({
                data: { id: opts?.insertId ?? "queue-1" },
                error: null,
              });
            },
          }),
        }),
      }),
    } as any,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("processGmailInboundMessage", () => {
  it("queues + emits import.queued when subject starts with IMPORT", async () => {
    const f = fakeSvc({ insertId: "q-9" });
    const r = await processGmailInboundMessage({
      tenant_id: "t1",
      message_id: "msg-1",
      subject: "IMPORT — lead from web form",
      body_text: "Customer: Jane Doe ...",
      svc: f.svc,
    });
    expect(r).toEqual({ qualified: true, import_queue_id: "q-9" });
    expect(inngest.send).toHaveBeenCalledWith({
      name: "import.queued",
      data: { tenant_id: "t1", import_queue_id: "q-9" },
    });
    expect(f.inserts.some((i) => i.table === "import_queue")).toBe(true);
  });

  it("queues + emits when body's first line starts with IMPORT", async () => {
    const f = fakeSvc({ insertId: "q-10" });
    const r = await processGmailInboundMessage({
      tenant_id: "t1",
      message_id: "msg-2",
      subject: "Fwd: lead alert",
      body_text: "IMPORT\nCustomer details below ...",
      svc: f.svc,
    });
    expect(r.qualified).toBe(true);
    expect(inngest.send).toHaveBeenCalledTimes(1);
  });

  it("skips when no IMPORT trigger present", async () => {
    const f = fakeSvc();
    const r = await processGmailInboundMessage({
      tenant_id: "t1",
      message_id: "msg-3",
      subject: "Re: chat with customer",
      body_text: "Hi, just following up...",
      svc: f.svc,
    });
    expect(r).toEqual({ qualified: false, reason: "no_trigger_word" });
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("skips empty messages", async () => {
    const f = fakeSvc();
    const r = await processGmailInboundMessage({
      tenant_id: "t1",
      message_id: "msg-4",
      subject: "",
      body_text: "",
      svc: f.svc,
    });
    expect(r).toEqual({ qualified: false, reason: "empty_body" });
    expect(inngest.send).not.toHaveBeenCalled();
  });

  it("does not match the word IMPORTANT (word boundary)", async () => {
    const f = fakeSvc();
    const r = await processGmailInboundMessage({
      tenant_id: "t1",
      message_id: "msg-5",
      subject: "IMPORTANT: client update",
      body_text: "see below",
      svc: f.svc,
    });
    expect(r.qualified).toBe(false);
    expect(inngest.send).not.toHaveBeenCalled();
  });
});
