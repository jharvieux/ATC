// #1582 — duplicate-event race must send exactly once.
//
// The bug: the content-row insert's error was discarded (`const { data:
// inserted } = await ...insert(...)`), so a 23505 unique-constraint
// violation from a concurrent duplicate `precruise/email.due` event was
// silently ignored and the code proceeded to send anyway — a double send.
// This pins that the insert error is now checked and a 23505 short-circuits
// before sendEmail is ever reached.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: unknown) => handler,
  },
}));

const mocks = vi.hoisted(() => ({
  insertError: null as { code: string; message: string } | null,
  insertPayloads: [] as Array<Record<string, unknown>>,
  sendEmailCalls: 0,
  revalidateCalls: [] as Array<[string, string]>,
  existingContent: null as {
    id: string;
    sent_at: string | null;
    send_claimed_at: string | null;
    generated_content: Record<string, unknown>;
    content_context_hash: string | null;
    provider_first_attempt_at?: string | null;
  } | null,
  logicalEmailLog: null as { id: string; status: string; sent_at: string | null; provider_first_attempt_at?: string | null } | null,
  recoveryCalls: 0,
  resumeCalls: 0,
  abandonCalls: 0,
  updatePayloads: [] as Array<Record<string, unknown>>,
  regenerationRace: null as "claimed" | "sent" | null,
  regenerationUpdateError: null as { code: string; message: string } | null,
  paymentResults: [] as boolean[],
}));

// #1953 — the content insert now purges the companion page's cache tag.
vi.mock("@/lib/precruise/companion-content", () => ({
  revalidateCompanionContent: (booking_id: string, phase: string) => {
    mocks.revalidateCalls.push([booking_id, phase]);
  },
}));

vi.mock("@/lib/billing/exclude-non-paying", () => ({
  assertTenantStillPayingById: async () => {
    const ok = mocks.paymentResults.shift() ?? true;
    return { ok, ...(ok ? {} : { reason: "past_grace", days_since_non_paying: 31 }) };
  },
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
        };
  },
  resumeIdempotentEmail: async () => {
    mocks.resumeCalls++;
    return { status: "sent", email_log_id: "log-1", resend_message_id: "resend-1" };
  },
  abandonUnstartedIdempotentEmail: async () => {
    mocks.abandonCalls++;
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
                    (nullFilters.has("send_claimed_at") && mocks.existingContent.send_claimed_at) ||
                    (nullFilters.has("provider_first_attempt_at") && mocks.existingContent.provider_first_attempt_at))
                ) {
                  return { data: [], error: null };
                }
                if ("generated_content" in payload && mocks.regenerationRace && mocks.existingContent) {
                  mocks.existingContent.generated_content = { documentation_reminder: "winning prose" };
                  if (mocks.regenerationRace === "claimed") {
                    mocks.existingContent.send_claimed_at = "2026-08-31T22:00:00.000Z";
                  } else {
                    mocks.existingContent.sent_at = "2026-08-31T22:00:00.000Z";
                  }
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
                          provider_first_attempt_at: mocks.existingContent?.provider_first_attempt_at ?? null,
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

import { precruiseGenerateAndSend } from "@/inngest/precruise-generate-and-send";

beforeEach(() => {
  mocks.insertError = null;
  mocks.insertPayloads = [];
  mocks.sendEmailCalls = 0;
  mocks.revalidateCalls = [];
  mocks.existingContent = null;
  mocks.updatePayloads = [];
  mocks.regenerationRace = null;
  mocks.regenerationUpdateError = null;
  mocks.paymentResults = [];
  mocks.logicalEmailLog = null;
  mocks.recoveryCalls = 0;
  mocks.resumeCalls = 0;
  mocks.abandonCalls = 0;
});

describe("precruiseGenerateAndSend — #1582 duplicate insert race", () => {
  it("recovers a committed logical send before regeneration and stamps the content row", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      generated_content: { documentation_reminder: "old copy" },
      content_context_hash: "stale",
    };
    mocks.logicalEmailLog = {
      id: "log-1",
      status: "sent",
      sent_at: "2026-08-31T22:00:00.000Z",
    };

    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90", via: "direct" } },
    });

    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.insertPayloads).toHaveLength(0);
    expect(mocks.updatePayloads).toContainEqual({
      sent_at: "2026-08-31T22:00:00.000Z",
      send_claimed_at: null,
    });
    expect(mocks.recoveryCalls).toBe(1);
  });

  it("resumes a started provider outbox after recipient/context change without regenerating", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      provider_first_attempt_at: "2026-08-31T22:00:00.000Z",
      generated_content: { documentation_reminder: "authoritative provider copy" },
      content_context_hash: "context-before-provider",
    };
    mocks.logicalEmailLog = {
      id: "log-1",
      status: "queued",
      sent_at: null,
      provider_first_attempt_at: "2026-08-31T22:00:00.100Z",
    };

    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: {
        data: {
          booking_id: "b1",
          tenant_id: "t1",
          phase: "t_90",
          via: "direct",
          expected_contact_id: "changed-contact",
          expected_contact_email: "changed@example.com",
        },
      },
    });

    expect(mocks.resumeCalls).toBe(1);
    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.insertPayloads).toHaveLength(0);
    expect(mocks.updatePayloads.some((payload) => "sent_at" in payload)).toBe(true);
  });

  it("abandons an unstarted stale outbox and releases its claim without regenerating", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: "2026-08-31T22:00:00.000Z",
      provider_first_attempt_at: null,
      generated_content: { documentation_reminder: "stale queued copy" },
      content_context_hash: "stale-context",
    };
    mocks.logicalEmailLog = {
      id: "log-1",
      status: "queued",
      sent_at: null,
      provider_first_attempt_at: null,
    };

    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90", via: "direct" } },
    });

    expect(mocks.abandonCalls).toBe(1);
    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.insertPayloads).toHaveLength(0);
    expect(mocks.updatePayloads).toContainEqual({ send_claimed_at: null });
  });

  it("skips the send when the insert hits a 23505 unique violation", async () => {
    mocks.insertError = { code: "23505", message: "duplicate key value violates unique constraint" };
    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90" } },
    });
    expect(mocks.sendEmailCalls).toBe(0);
  });

  it("sends when the insert succeeds (no race)", async () => {
    mocks.insertError = null;
    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90" } },
    });
    expect(mocks.sendEmailCalls).toBe(1);
    expect(mocks.insertPayloads[0]).toMatchObject({
      booking_id: "b1",
      contact_id: "contact-1",
    });
    // #1953 — the successful content insert must purge the companion
    // page's (booking_id, phase) cache entry, or a pre-insert "no content"
    // render stays pinned for the customer.
    expect(mocks.revalidateCalls).toEqual([["b1", "t_90"]]);
  });

  it("makes the T-30 specialty experiences section reachable in direct sends", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    try {
      await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
        event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_30", via: "direct" } },
      });
    } finally {
      vi.unstubAllEnvs();
    }

    expect(mocks.insertPayloads[0]?.generated_content).toMatchObject({
      specialty_experiences: ["unused"],
    });
  });

  it("regenerates unsent cached content when the booking/contact context fingerprint is stale", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      generated_content: { documentation_reminder: "old copy" },
      content_context_hash: "stale",
    };

    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90", via: "direct" } },
    });

    expect(mocks.insertPayloads).toHaveLength(0);
    const regeneration = mocks.updatePayloads.find((payload) => "generated_content" in payload);
    expect(regeneration).toMatchObject({
      contact_id: "contact-1",
      content_context_hash: expect.not.stringMatching(/^stale$/),
      generated_content: expect.objectContaining({
        documentation_reminder: expect.not.stringMatching(/^old copy$/),
      }),
    });
    expect(mocks.sendEmailCalls).toBe(1);
  });

  it("sends the persisted variant when cached content already matches the current context", async () => {
    const fingerprint = createHash("sha256")
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
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      generated_content: { documentation_reminder: "authoritative copy" },
      content_context_hash: fingerprint,
    };

    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90", via: "direct" } },
    });

    expect(mocks.updatePayloads.filter((payload) => "generated_content" in payload)).toHaveLength(0);
    expect(mocks.sendEmailCalls).toBe(1);
  });

  it("does not let a slow direct regeneration overwrite content claimed by the winner", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      generated_content: { documentation_reminder: "old copy" },
      content_context_hash: "stale",
    };
    mocks.regenerationRace = "claimed";

    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90", via: "direct" } },
    });

    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.existingContent.generated_content).toEqual({ documentation_reminder: "winning prose" });
    expect(mocks.existingContent.send_claimed_at).not.toBeNull();
  });

  it("does not regenerate content after the first provider attempt has fixed the keyed payload", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      provider_first_attempt_at: "2026-08-31T20:00:00.000Z",
      generated_content: { documentation_reminder: "provider-attempted copy" },
      content_context_hash: "stale",
    };

    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90", via: "direct" } },
    });

    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.existingContent.generated_content).toEqual({ documentation_reminder: "provider-attempted copy" });
  });

  it("fails loudly when the guarded direct regeneration update fails", async () => {
    mocks.existingContent = {
      id: "content-1",
      sent_at: null,
      send_claimed_at: null,
      generated_content: { documentation_reminder: "old copy" },
      content_context_hash: "stale",
    };
    mocks.regenerationUpdateError = { code: "40001", message: "serialization failure" };

    await expect(
      (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
        event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90", via: "direct" } },
      }),
    ).rejects.toThrow();
    expect(mocks.sendEmailCalls).toBe(0);
  });

  it("does not retarget a scheduled manual send after the reviewed contact changes", async () => {
    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: {
        data: {
          booking_id: "b1",
          tenant_id: "t1",
          phase: "t_30",
          via: "direct",
          expected_contact_id: "contact-2",
          expected_contact_email: "jordan@example.com",
        },
      },
    });

    expect(mocks.insertPayloads).toHaveLength(0);
    expect(mocks.sendEmailCalls).toBe(0);
  });

  it("does not send direct content when the tenant becomes ineligible after generation", async () => {
    mocks.paymentResults = [true, false];

    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90", via: "direct" } },
    });

    expect(mocks.insertPayloads).toHaveLength(1);
    expect(mocks.sendEmailCalls).toBe(0);
  });

  it("throws (not swallows) on a non-23505 insert error", async () => {
    mocks.insertError = { code: "42501", message: "permission denied" };
    await expect(
      (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
        event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90" } },
      }),
    ).rejects.toThrow();
    expect(mocks.sendEmailCalls).toBe(0);
  });
});
