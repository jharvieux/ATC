// #1676 — precruiseSendFromBatchResult (the ai.batch_request.completed
// consumer for the §27.12 "batched" T-90/T-30/T-7 path) got the identical
// #1582 fix as the direct path (precruiseGenerateAndSend, pinned by
// precruise-duplicate-race.test.ts): check the insert error, short-circuit
// on 23505 instead of discarding it and sending anyway. Only the direct
// path had a regression test before this. Mirrors precruise-duplicate-race
// so a future refactor that touches only this twin still fails a test if
// it reintroduces the double-send / silent-loss bug.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: unknown) => {
      const run = handler as (args: Record<string, unknown>) => Promise<unknown>;
      return (args: Record<string, unknown>) => run({
        ...args,
        step: args.step ?? { run: async (_id: string, fn: () => unknown) => await fn() },
      });
    },
  },
}));

const mocks = vi.hoisted(() => ({
  insertError: null as { code: string; message: string } | null,
  insertPayloads: [] as Array<Record<string, unknown>>,
  sendEmailCalls: 0,
  revalidateCalls: [] as Array<[string, string]>,
  batchEnqueueCalls: [] as Array<Record<string, unknown>>,
  existingContent: null as {
    id: string;
    sent_at: string | null;
    send_claimed_at: string | null;
    generated_content: Record<string, unknown>;
    content_context_hash?: string | null;
  } | null,
  logicalEmailLog: null as {
    id: string;
    status: string;
    sent_at: string | null;
    provider_first_attempt_at?: string | null;
    provider_attempt_state?: "unstarted" | "ambiguous" | "rejected";
  } | null,
  recoveryCalls: 0,
  resumeCalls: 0,
  abandonCalls: 0,
  startWinsOnAbandon: false,
  updatePayloads: [] as Array<Record<string, unknown>>,
  regenerationRace: null as "sent" | null,
  regenerationUpdateError: null as { code: string; message: string } | null,
  tenantPaying: true,
}));

vi.mock("@/lib/ai/batch/enqueue", () => ({
  enqueueBatchRequest: async (args: Record<string, unknown>) => {
    mocks.batchEnqueueCalls.push(args);
  },
}));

// #1953 — the content insert/update now purges the companion page's cache tag.
vi.mock("@/lib/precruise/companion-content", () => ({
  revalidateCompanionContent: (booking_id: string, phase: string) => {
    mocks.revalidateCalls.push([booking_id, phase]);
  },
}));

vi.mock("@/lib/billing/exclude-non-paying", () => ({
  assertTenantStillPayingById: async () => ({
    ok: mocks.tenantPaying,
    ...(mocks.tenantPaying ? {} : { reason: "past_grace", days_since_non_paying: 31 }),
  }),
}));

vi.mock("@/lib/ai/call-wrapper", () => ({
  instrumentedClaudeCall: async () => ({ text: "unused" }),
}));

vi.mock("@/lib/email/unsubscribe-token", () => ({
  signCompanionToken: () => "companion-token",
  signUnsubscribeToken: () => "unsub-token",
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: async () => {
    mocks.sendEmailCalls++;
    return { status: "sent", email_log_id: "log-1" };
  },
  recoverIdempotentEmail: async () => {
    mocks.recoveryCalls++;
    if (!mocks.logicalEmailLog) return { status: "missing" };
    return mocks.logicalEmailLog.sent_at
      ? {
          status: "sent",
          email_log_id: mocks.logicalEmailLog.id,
          sent_at: mocks.logicalEmailLog.sent_at,
        }
      : {
          status: "queued",
          email_log_id: mocks.logicalEmailLog.id,
          provider_first_attempt_at: mocks.logicalEmailLog.provider_first_attempt_at ?? null,
          provider_attempt_state: mocks.logicalEmailLog.provider_attempt_state
            ?? (mocks.logicalEmailLog.provider_first_attempt_at ? "ambiguous" : "unstarted"),
        };
  },
  resumeIdempotentEmail: async () => {
    mocks.resumeCalls++;
    return { status: "sent", email_log_id: "log-1", resend_message_id: "resend-1" };
  },
  abandonUnstartedIdempotentEmail: async () => {
    mocks.abandonCalls++;
    if (mocks.startWinsOnAbandon && mocks.logicalEmailLog) {
      mocks.logicalEmailLog.provider_first_attempt_at = new Date().toISOString();
      mocks.logicalEmailLog.provider_attempt_state = "ambiguous";
      return false;
    }
    mocks.logicalEmailLog = null;
    return true;
  },
  TENANT_BRANDING_COLUMNS:
    "tenant_id, logo_url, primary_color, secondary_color, accent_color, slogan, " +
    "email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, " +
    "email_from_name, email_from_domain, email_from_domain_verified_at",
}));

vi.mock("@/lib/email/template-resolve", () => ({
  resolveEmailContent: async () => ({ subject: "Subject", overrideBodyText: "Body" }),
  renderOverrideBodyInLayout: async () => "<html>mock</html>",
}));

vi.mock("@/lib/sailings/sailing-itinerary", () => ({
  getSailingItinerary: async () => null,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      if (table === "email_log") {
        return {
          select() {
            const chain = {
              eq: () => chain,
              limit: () => chain,
              maybeSingle: async () => ({ data: mocks.logicalEmailLog, error: null }),
            };
            return chain;
          },
        };
      }
      if (table === "pre_cruise_email_content") {
        return {
          select() {
            const chain = {
              eq: () => chain,
              maybeSingle: async () => ({ data: mocks.existingContent, error: null }),
            };
            return chain;
          },
          insert(payload: Record<string, unknown>) {
            mocks.insertPayloads.push(payload);
            return {
              select: () => ({
                single: async () => ({ data: { id: "content-1" }, error: mocks.insertError }),
              }),
            };
          },
          update(payload: Record<string, unknown>) {
            mocks.updatePayloads.push(payload);
            const nullFilters = new Set<string>();
            const chain = {
              eq: () => chain,
              is: (column: string, value: unknown) => {
                if (value === null) nullFilters.add(column);
                return chain;
              },
              or: () => chain,
              select: async () => {
                if ("generated_content" in payload && mocks.regenerationUpdateError) {
                  return { data: null, error: mocks.regenerationUpdateError };
                }
                if (
                  "generated_content" in payload && mocks.existingContent &&
                  ((nullFilters.has("sent_at") && mocks.existingContent.sent_at) ||
                    (nullFilters.has("send_claimed_at") && mocks.existingContent.send_claimed_at))
                ) {
                  return { data: [], error: null };
                }
                if ("generated_content" in payload && mocks.regenerationRace && mocks.existingContent) {
                  mocks.existingContent.sent_at = "2026-08-31T22:00:00.000Z";
                  mocks.existingContent.generated_content = { summary: "winning prose" };
                  if (nullFilters.has("sent_at") && nullFilters.has("send_claimed_at")) {
                    return { data: [], error: null };
                  }
                  mocks.existingContent.generated_content = payload.generated_content as Record<string, unknown>;
                }
                if ("generated_content" in payload && mocks.existingContent) {
                  mocks.existingContent.generated_content = payload.generated_content as Record<string, unknown>;
                  mocks.existingContent.content_context_hash = payload.content_context_hash as string;
                }
                return {
                  data: "send_claimed_at" in payload
                    ? payload.send_claimed_at
                      ? [{
                          send_claimed_at: payload.send_claimed_at,
                          content_context_hash:
                            mocks.existingContent?.content_context_hash ??
                            mocks.insertPayloads.at(-1)?.content_context_hash ??
                            null,
                          generated_content:
                            mocks.existingContent?.generated_content ??
                            mocks.insertPayloads.at(-1)?.generated_content ??
                            {},
                        }]
                      : [{ id: "content-1" }]
                    : [{ id: "content-1" }],
                  error: null,
                };
              },
            };
            return chain;
          },
        };
      }
      if (table === "bookings") {
        return {
          select() {
            const chain = {
              eq: () => chain,
              maybeSingle: async () => ({
                data: {
                  id: "b1",
                  tenant_id: "t1",
                  status: "confirmed",
                  group_booking_id: "g1",
                  user_id: "u1",
                  primary_contact_id: "contact-1",
                  groups: {
                    cruise_line: "Norwegian",
                    ship_name: "Bliss",
                    sailing_date: "2026-09-01",
                    departure_port: "Miami, FL",
                  },
                  contacts: {
                    tenant_id: "t1",
                    first_name: "Jordan",
                    email: "jordan@example.com",
                  },
                },
                error: null,
              }),
            };
            return chain;
          },
        };
      }
      if (table === "contacts") {
        return {
          select() {
            const chain = {
              eq: () => chain,
              maybeSingle: async () => ({ data: { first_name: "Jordan", email: "jordan@example.com" }, error: null }),
            };
            return chain;
          },
        };
      }
      if (table === "tenants") {
        return {
          select() {
            const chain = {
              eq: () => chain,
              limit: () => chain,
              maybeSingle: async () => ({ data: { id: "t1", legal_name: "Anchor & Compass" }, error: null }),
            };
            return chain;
          },
        };
      }
      // tenant_branding
      return {
        select() {
          const chain = {
            eq: () => chain,
            limit: () => chain,
            maybeSingle: async () => ({ data: {}, error: null }),
          };
          return chain;
        },
      };
    },
  }),
}));

import { precruiseSendFromBatchResult } from "@/inngest/precruise-generate-and-send";

type BatchResultEvent = {
  event: {
    data: {
      request_id: string;
      tenant_id: string;
      result_text: string;
      caller_metadata: {
        booking_id: string;
        tenant_id: string;
        phase: string;
        email_ctx_id: string | null;
        companion_page_url: string;
        content_context_hash?: string;
        expected_contact_id?: string;
        expected_contact_email?: string;
      } | null;
    };
  };
};

function runHandler(
  event: BatchResultEvent,
  step?: { run: (id: string, fn: () => unknown) => Promise<unknown> },
): Promise<void> {
  return (precruiseSendFromBatchResult as unknown as (
    args: BatchResultEvent & { step?: typeof step },
  ) => Promise<void>)({ ...event, ...(step ? { step } : {}) });
}

function makeEvent(): BatchResultEvent {
  const contentContextFingerprint = createHash("sha256")
    .update(JSON.stringify({
      contact_id: "contact-1",
      recipient_email: "jordan@example.com",
      customer_name: "Jordan",
      cruise_line: "Norwegian",
      ship_name: "Bliss",
      sailing_date: "2026-09-01",
      departure_port: "Miami, FL",
      ports: [],
    }))
    .digest("hex");
  return {
    event: {
      data: {
        request_id: "req-1",
        tenant_id: "t1",
        result_text: JSON.stringify({ summary: "Enjoy your cruise!" }),
        caller_metadata: {
          booking_id: "b1",
          tenant_id: "t1",
          phase: "t_90",
          email_ctx_id: null,
          companion_page_url: "https://example.com/companion/abc",
          content_context_hash: contentContextFingerprint,
        },
      },
    },
  };
}

beforeEach(() => {
  mocks.insertError = null;
  mocks.insertPayloads = [];
  mocks.sendEmailCalls = 0;
  mocks.revalidateCalls = [];
  mocks.batchEnqueueCalls = [];
  mocks.existingContent = null;
  mocks.regenerationRace = null;
  mocks.regenerationUpdateError = null;
  mocks.tenantPaying = true;
  mocks.logicalEmailLog = null;
  mocks.recoveryCalls = 0;
  mocks.resumeCalls = 0;
  mocks.abandonCalls = 0;
  mocks.startWinsOnAbandon = false;
  mocks.updatePayloads = [];
});

describe("precruiseSendFromBatchResult — #1582/#1676 duplicate insert race (batched-path twin)", () => {
  it("recovers a committed logical send before parsing or regenerating batch content", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      generated_content: { summary: "old copy" },
      content_context_hash: "stale",
    };
    mocks.logicalEmailLog = {
      id: "log-1",
      status: "sent",
      sent_at: "2026-08-31T22:00:00.000Z",
    };
    const event = makeEvent();
    event.event.data.result_text = "not json because recovery runs first";

    await runHandler(event);

    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.insertPayloads).toHaveLength(0);
    expect(mocks.recoveryCalls).toBe(1);
    expect(mocks.updatePayloads).toContainEqual({
      sent_at: "2026-08-31T22:00:00.000Z",
      send_claimed_at: null,
    });
  });

  it("resumes a started provider outbox before parsing changed batch context", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      generated_content: { summary: "authoritative provider copy" },
      content_context_hash: "context-before-provider",
    };
    mocks.logicalEmailLog = {
      id: "log-1",
      status: "queued",
      sent_at: null,
      provider_first_attempt_at: new Date().toISOString(),
    };
    const event = makeEvent();
    event.event.data.result_text = "changed result is intentionally not parsed";
    event.event.data.caller_metadata!.expected_contact_id = "changed-contact";
    event.event.data.caller_metadata!.expected_contact_email = "changed@example.com";

    await runHandler(event);

    expect(mocks.resumeCalls).toBe(1);
    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.insertPayloads).toHaveLength(0);
    expect(mocks.updatePayloads.some((payload) => "sent_at" in payload)).toBe(true);
  });

  it("re-enters live batch context after a definitive provider rejection", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      generated_content: { summary: "rejected stale copy" },
      content_context_hash: "stale",
    };
    mocks.logicalEmailLog = {
      id: "log-1",
      status: "queued",
      sent_at: null,
      provider_first_attempt_at: "2026-08-31T22:00:00.100Z",
      provider_attempt_state: "rejected",
    };

    await runHandler(makeEvent());

    expect(mocks.resumeCalls).toBe(0);
    expect(mocks.abandonCalls).toBe(1);
    expect(mocks.sendEmailCalls).toBe(1);
    expect(mocks.existingContent.generated_content).toEqual({ summary: "Enjoy your cruise!" });
  });

  it("abandons an unstarted stale outbox before regenerating and sending batch content", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: "2026-08-31T22:00:00.000Z",
      generated_content: { summary: "stale queued copy" },
      content_context_hash: "stale-context",
    };
    mocks.logicalEmailLog = {
      id: "log-1",
      status: "queued",
      sent_at: null,
      provider_first_attempt_at: null,
    };
    await runHandler(makeEvent());

    expect(mocks.abandonCalls).toBe(1);
    expect(mocks.sendEmailCalls).toBe(1);
    expect(mocks.insertPayloads).toHaveLength(0);
    expect(mocks.batchEnqueueCalls).toHaveLength(0);
    expect(mocks.updatePayloads).toContainEqual({ send_claimed_at: null });
  });

  it("re-reads and resumes when provider start wins the batch abandon CAS", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: "2026-09-01T04:00:00.000Z",
      generated_content: { summary: "authoritative queued copy" },
      content_context_hash: "stale-context",
    };
    mocks.logicalEmailLog = {
      id: "log-1",
      status: "queued",
      sent_at: null,
      provider_first_attempt_at: null,
    };
    mocks.startWinsOnAbandon = true;
    const event = makeEvent();
    event.event.data.result_text = "not JSON because the started outbox wins first";

    await runHandler(event);

    expect(mocks.abandonCalls).toBe(1);
    expect(mocks.recoveryCalls).toBe(2);
    expect(mocks.resumeCalls).toBe(1);
    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.batchEnqueueCalls).toHaveLength(0);
    expect(mocks.existingContent.generated_content).toEqual({
      summary: "authoritative queued copy",
    });
    expect(mocks.updatePayloads).not.toContainEqual({ send_claimed_at: null });
  });

  it("rejects caller metadata from a different tenant before reading content", async () => {
    const event = makeEvent();
    event.event.data.caller_metadata!.tenant_id = "other-tenant";

    await runHandler(event);

    expect(mocks.recoveryCalls).toBe(0);
    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.insertPayloads).toHaveLength(0);
    expect(mocks.batchEnqueueCalls).toHaveLength(0);
  });

  it("skips the send when the insert hits a 23505 unique violation", async () => {
    mocks.insertError = { code: "23505", message: "duplicate key value violates unique constraint" };
    await runHandler(makeEvent());
    expect(mocks.sendEmailCalls).toBe(0);
    // #1953 — the race branch wrote nothing, so it must not purge the
    // companion cache either (the winning run owns that).
    expect(mocks.revalidateCalls).toEqual([]);
  });

  it("sends when the insert succeeds (no race)", async () => {
    mocks.insertError = null;
    await runHandler(makeEvent());
    expect(mocks.sendEmailCalls).toBe(1);
    expect(mocks.insertPayloads[0]).toMatchObject({
      booking_id: "b1",
      contact_id: "contact-1",
    });
    // #1953 — content landed, so the companion page's (booking_id, phase)
    // cache entry must be purged or a placeholder-phase render stays pinned.
    expect(mocks.revalidateCalls).toEqual([["b1", "t_90"]]);
  });

  it("uses the persisted authoritative variant when concurrent batch results differ", async () => {
    const event = makeEvent();
    const fingerprint = event.event.data.caller_metadata!.content_context_hash!;
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      generated_content: { summary: "authoritative prose" },
      content_context_hash: fingerprint,
    };
    event.event.data.result_text = JSON.stringify({ summary: "late competing prose" });

    await runHandler(event);

    expect(mocks.sendEmailCalls).toBe(1);
    expect(mocks.existingContent.generated_content).toEqual({ summary: "authoritative prose" });
  });

  it("throws (not swallows) on a non-23505 insert error — the batch consumer must fail loud for Inngest retry, same as the direct path", async () => {
    mocks.insertError = { code: "42501", message: "permission denied" };
    await expect(runHandler(makeEvent())).rejects.toThrow();
    expect(mocks.sendEmailCalls).toBe(0);
  });

  it("re-enqueues generation instead of sending content built from stale booking context", async () => {
    const event = makeEvent();
    event.event.data.caller_metadata!.content_context_hash = "stale";

    await runHandler(event);

    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.batchEnqueueCalls).toHaveLength(1);
    expect(mocks.batchEnqueueCalls[0]?.caller_metadata).toMatchObject({
      booking_id: "b1",
      content_context_hash: expect.not.stringMatching(/^stale$/),
    });
  });

  it("memoizes a stale-context batch re-enqueue across handler retries", async () => {
    const event = makeEvent();
    event.event.data.caller_metadata!.content_context_hash = "stale";
    const durableResults = new Map<string, unknown>();
    const stepIds: string[] = [];
    const step = {
      run: async (id: string, fn: () => unknown) => {
        stepIds.push(id);
        if (durableResults.has(id)) return durableResults.get(id);
        const value = await fn();
        durableResults.set(id, value);
        return value;
      },
    };

    await runHandler(event, step);
    await runHandler(event, step);

    const currentHash = (mocks.batchEnqueueCalls[0]?.caller_metadata as {
      content_context_hash: string;
    }).content_context_hash;
    expect(stepIds).toEqual([
      `reenqueue-batch:t_90:${currentHash}`,
      `reenqueue-batch:t_90:${currentHash}`,
    ]);
    expect(mocks.batchEnqueueCalls).toHaveLength(1);
    expect(mocks.sendEmailCalls).toBe(0);
  });

  it("does not retarget a reviewed manual batch after the primary contact changes", async () => {
    const event = makeEvent();
    event.event.data.caller_metadata!.expected_contact_id = "contact-2";
    event.event.data.caller_metadata!.expected_contact_email = "jordan@example.com";

    await runHandler(event);

    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.insertPayloads).toHaveLength(0);
    expect(mocks.batchEnqueueCalls).toHaveLength(0);
  });

  it("does not retarget a reviewed manual batch after only the reviewed email changes", async () => {
    const event = makeEvent();
    event.event.data.caller_metadata!.expected_contact_id = "contact-1";
    event.event.data.caller_metadata!.expected_contact_email = "old-address@example.com";

    await runHandler(event);

    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.insertPayloads).toHaveLength(0);
    expect(mocks.batchEnqueueCalls).toHaveLength(0);
  });

  it("does not let a slow batch result overwrite prose already sent by the winner", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      generated_content: { summary: "old prose" },
    };
    mocks.regenerationRace = "sent";

    await runHandler(makeEvent());

    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.existingContent.sent_at).not.toBeNull();
    expect(mocks.existingContent.generated_content).toEqual({ summary: "winning prose" });
  });

  it("fails loudly after releasing the claim when the batch replay window expires", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      generated_content: { summary: "provider-attempted prose" },
      content_context_hash: "stale",
    };
    mocks.logicalEmailLog = {
      id: "log-1",
      status: "queued",
      sent_at: null,
      provider_first_attempt_at: new Date(Date.now() - 23 * 60 * 60_000).toISOString(),
    };

    await expect(runHandler(makeEvent())).rejects.toThrow(/operator reconciliation required/);

    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.resumeCalls).toBe(0);
    expect(mocks.existingContent.send_claimed_at).toBeNull();
    expect(mocks.existingContent.generated_content).toEqual({ summary: "provider-attempted prose" });
  });

  it("fails loudly when the guarded batch regeneration update fails", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      generated_content: { summary: "old prose" },
    };
    mocks.regenerationUpdateError = { code: "40001", message: "serialization failure" };

    await expect(runHandler(makeEvent())).rejects.toThrow();
    expect(mocks.sendEmailCalls).toBe(0);
  });

  it("does not send a completed batch result after the tenant becomes ineligible", async () => {
    mocks.tenantPaying = false;

    await runHandler(makeEvent());

    expect(mocks.insertPayloads).toHaveLength(1);
    expect(mocks.sendEmailCalls).toBe(0);
  });
});
