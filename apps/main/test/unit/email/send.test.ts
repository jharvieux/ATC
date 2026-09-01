// §23 — sendEmail happy path + suppression + rate limit tests.
//
// We test the deterministic paths: suppression blocks, rate limit blocks,
// missing key fails. The actual Resend fetch call is intercepted via the
// vi.stubGlobal fetch mock so no real HTTP happens.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { providerEmailIdempotencyKey, sendEmail, type SendEmailInput } from "@/lib/email/send";
import type { SupabaseClient } from "@supabase/supabase-js";

const testHtml = "<p>Test email body</p>";

const mocks = vi.hoisted(() => ({
  transitions: [] as Array<Record<string, unknown>>,
  transitionError: null as Error | null,
}));

vi.mock("@/lib/abuse/snapshot", () => ({
  loadTenantSnapshot: async (_db: unknown, tenant_id: string) => ({
    tenant: { tenant_id, tier_code: "byo_research", seat_count: 1, billing_period: "monthly" },
  }),
}));

vi.mock("@/lib/abuse/state-machine", () => ({
  checkStateTransitionIfNeeded: async (args: Record<string, unknown>) => {
    mocks.transitions.push(args);
    if (mocks.transitionError) throw mocks.transitionError;
  },
}));

type DbChain = Record<string, unknown>;

interface MockOutbox {
  id: string;
  status: string;
  sent_at: string | null;
  resend_message_id: string | null;
  provider_idempotency_key: string;
  provider_request_body: string;
  provider_account_type: "platform_resend" | "tenant_resend";
  provider_first_attempt_at: string | null;
}

interface MockOutboxStore {
  current: MockOutbox | null;
}

function makeDb({
  suppressions = [] as unknown[],
  logCount = 0,
  insertId = "log-1",
  logInsertError = null as { message: string } | null,
  logInserts = null as Record<string, unknown>[] | null,
  retryContentInserts = null as Record<string, unknown>[] | null,
  rpcCalls = null as Array<{ name: string; args: Record<string, unknown> }> | null,
  rpcErrors = {} as Record<string, { message: string }>,
  rpcFailureCounts = {} as Record<string, number>,
  outboxStore = { current: null } as MockOutboxStore,
}: {
  suppressions?: unknown[];
  logCount?: number;
  insertId?: string;
  logInsertError?: { message: string } | null;
  logInserts?: Record<string, unknown>[] | null;
  retryContentInserts?: Record<string, unknown>[] | null;
  rpcCalls?: Array<{ name: string; args: Record<string, unknown> }> | null;
  rpcErrors?: Record<string, { message: string }>;
  rpcFailureCounts?: Record<string, number>;
  outboxStore?: MockOutboxStore;
} = {}): SupabaseClient {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls?.push({ name, args });
      if ((rpcFailureCounts[name] ?? 0) > 0) {
        rpcFailureCounts[name] = (rpcFailureCounts[name] ?? 0) - 1;
        return { data: null, error: rpcErrors[name] ?? { message: `${name} failed` } };
      }
      if (rpcErrors[name] && !(name in rpcFailureCounts)) return { data: null, error: rpcErrors[name] };
      if (name === "prepare_idempotent_email_send") {
        if (!outboxStore.current) {
          outboxStore.current = {
            id: insertId,
            status: "queued",
            sent_at: null,
            resend_message_id: null,
            provider_idempotency_key: String(args.p_provider_idempotency_key),
            provider_request_body: String(args.p_provider_request_body),
            provider_account_type: String(args.p_provider_account_type) as MockOutbox["provider_account_type"],
            provider_first_attempt_at: null,
          };
        }
        return {
          data: [{
            email_log_id: outboxStore.current.id,
            email_status: outboxStore.current.status,
            sent_at: outboxStore.current.sent_at,
            resend_message_id: outboxStore.current.resend_message_id,
            provider_idempotency_key: outboxStore.current.provider_idempotency_key,
            provider_request_body: outboxStore.current.provider_request_body,
            provider_first_attempt_at: outboxStore.current.provider_first_attempt_at,
            newly_queued: outboxStore.current.provider_first_attempt_at === null,
          }],
          error: null,
        };
      }
      if (name === "start_idempotent_email_dispatch") {
        if (!outboxStore.current) return { data: null, error: { message: "missing outbox" } };
        outboxStore.current.provider_first_attempt_at ??= "2026-08-31T12:00:00.000Z";
        return {
          data: [{
            email_log_id: outboxStore.current.id,
            provider_idempotency_key: outboxStore.current.provider_idempotency_key,
            provider_request_body: outboxStore.current.provider_request_body,
            provider_account_type: outboxStore.current.provider_account_type,
            provider_first_attempt_at: outboxStore.current.provider_first_attempt_at,
          }],
          error: null,
        };
      }
      if (name === "finalize_idempotent_email_send") {
        if (!outboxStore.current) return { data: null, error: { message: "missing outbox" } };
        outboxStore.current.status = "sent";
        outboxStore.current.sent_at ??= "2026-08-31T12:00:01.000Z";
        outboxStore.current.resend_message_id ??= String(args.p_resend_message_id);
        return {
          data: [{ email_log_id: outboxStore.current.id, newly_recorded: true, email_sent_today: 7 }],
          error: null,
        };
      }
      if (name === "abandon_unstarted_idempotent_email") {
        if (!outboxStore.current?.provider_first_attempt_at) outboxStore.current = null;
        return { data: true, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    from: (table: string) => {
      if (table === "email_retry_content") {
        return {
          insert: (payload: Record<string, unknown>) => {
            retryContentInserts?.push(payload);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      if (table === "email_suppressions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                in: () => ({
                  or: vi.fn().mockResolvedValue({ data: suppressions, error: null }),
                }),
              }),
            }),
          }),
        };
      }
      if (table === "email_log") {
        const countChain: DbChain = {
          select: (columns: string) => {
            if (columns.includes("provider_first_attempt_at")) {
              const outboxChain: DbChain = {
                eq: () => outboxChain,
                limit: () => outboxChain,
                maybeSingle: vi.fn().mockImplementation(async () => ({
                  data: outboxStore.current ? {
                    id: outboxStore.current.id,
                    status: outboxStore.current.status,
                    sent_at: outboxStore.current.sent_at,
                    resend_message_id: outboxStore.current.resend_message_id,
                    provider_first_attempt_at: outboxStore.current.provider_first_attempt_at,
                  } : null,
                  error: null,
                })),
              };
              return outboxChain;
            }
            return countChain;
          },
          eq: () => countChain,
          gte: () => countChain,
          not: vi.fn().mockResolvedValue({ data: Array(logCount).fill({ id: "x" }), error: null }),
          insert: (payload: Record<string, unknown>) => {
            logInserts?.push(payload);
            return {
              select: () => ({
                single: vi.fn().mockResolvedValue(
                  logInsertError ? { data: null, error: logInsertError } : { data: { id: insertId }, error: null },
                ),
              }),
            };
          },
        };
        return countChain as unknown as ReturnType<SupabaseClient["from"]>;
      }
      return {} as ReturnType<SupabaseClient["from"]>;
    },
  } as unknown as SupabaseClient;
}

const baseTenant: SendEmailInput["tenant"] = {
  id: "tenant-1",
  legal_name: "Test Agency",
  mailing_address: "123 Main St, Miami FL",
  email_send_pattern: "platform_resend",
  email_from_address: "noreply@test.com",
  email_from_name: "Test Agency",
};

describe("sendEmail — §23", () => {
  beforeEach(() => {
    mocks.transitions = [];
    mocks.transitionError = null;
    process.env.RESEND_API_KEY = "re_test_key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "resend-msg-123" }),
      text: async () => "",
    }));
  });

  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    vi.unstubAllGlobals();
  });

  it("sends email and returns sent status on happy path", async () => {
    const db = makeDb();
    const result = await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Test Subject",
      template_id: "test_template",
      category: "transactional",
      html: testHtml,
    });
    expect(result.status).toBe("sent");
    expect(result.resend_message_id).toBe("resend-msg-123");
  });

  it("falls back to legal_name when email_from_name is an empty string (Resend 422 regression)", async () => {
    // tenant_branding stores "" (not NULL) for an unset from-name. Nullish
    // coalescing let "" through, yielding a " <addr>" from header that Resend
    // rejects with 422 "Invalid `from` field" — a silent fail-soft delivery
    // failure. Empty/whitespace must fall through to legal_name.
    const db = makeDb();
    const result = await sendEmail({
      db,
      tenant: { ...baseTenant, email_from_name: "", legal_name: "Lisa Travel LLC", email_from_address: "noreply@test.com" },
      to: "customer@example.com",
      subject: "Test",
      template_id: "t",
      category: "transactional",
      html: testHtml,
    });
    expect(result.status).toBe("sent");
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const body = JSON.parse((calls[0]?.[1]?.body as string) ?? "{}") as { from: string };
    expect(body.from).toBe("Lisa Travel LLC <noreply@test.com>");
  });

  it("returns suppressed when email_suppressions match", async () => {
    const db = makeDb({ suppressions: [{ reason: "hard_bounce" }] });
    const result = await sendEmail({
      db,
      tenant: baseTenant,
      to: "bounced@example.com",
      subject: "Test",
      template_id: "t",
      category: "transactional",
      html: testHtml,
    });
    expect(result.status).toBe("suppressed");
    expect(result.reason).toBe("hard_bounce");
  });

  it("returns rate_limited for marketing email at limit (4 sent)", async () => {
    const db = makeDb({ suppressions: [], logCount: 4 });
    const result = await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Marketing email",
      template_id: "promo",
      category: "marketing",
      html: testHtml,
    });
    expect(result.status).toBe("rate_limited");
    expect(result.reason).toBe("marketing_monthly_limit_reached");
  });

  it("still returns sent when the email_log insert errors (#400 — log failure is non-fatal)", async () => {
    // The email was already handed to the vendor; a failed audit-log insert
    // must NOT flip the result to "failed". Pre-fix the error was discarded;
    // post-fix it is warned-and-swallowed, so the send still reports sent.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = makeDb({ logInsertError: { message: "email_log insert boom" } });
    const result = await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Test Subject",
      template_id: "test_template",
      category: "transactional",
      html: testHtml,
    });
    expect(result.status).toBe("sent");
    expect(result.email_log_id).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("email_log insert failed"));
    warn.mockRestore();
  });

  it("forwards idempotencyKey as the Resend Idempotency-Key header when provided (#1580)", async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const db = makeDb({ rpcCalls });
    await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Test Subject",
      template_id: "test_template",
      category: "transactional",
      html: testHtml,
      idempotencyKey: "pre_cruise:booking-1:t_7",
    });
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const headers = calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(
      providerEmailIdempotencyKey("tenant-1", "pre_cruise:booking-1:t_7"),
    );
    expect(rpcCalls.map((call) => call.name)).toEqual([
      "prepare_idempotent_email_send",
      "start_idempotent_email_dispatch",
      "finalize_idempotent_email_send",
    ]);
    expect(rpcCalls[0]).toMatchObject({
      name: "prepare_idempotent_email_send",
      args: {
        p_tenant_id: "tenant-1",
        p_idempotency_key: "pre_cruise:booking-1:t_7",
        p_retry_content: { html: testHtml },
      },
    });
    expect(mocks.transitions).toHaveLength(1);
    expect(mocks.transitions[0]).toMatchObject({
      dimension: "email_volume",
      metric_value: 7n,
    });
  });

  it("namespaces the provider key by tenant without truncating the logical key", async () => {
    const logicalKey = `group_reminder:${"x".repeat(300)}`;
    await sendEmail({
      db: makeDb(),
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Tenant one",
      template_id: "test_template",
      category: "transactional",
      html: testHtml,
      idempotencyKey: logicalKey,
    });
    await sendEmail({
      db: makeDb(),
      tenant: { ...baseTenant, id: "tenant-2" },
      to: "customer@example.com",
      subject: "Tenant two",
      template_id: "test_template",
      category: "transactional",
      html: testHtml,
      idempotencyKey: logicalKey,
    });

    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const firstKey = (calls[0]?.[1]?.headers as Record<string, string>)["Idempotency-Key"];
    const secondKey = (calls[1]?.[1]?.headers as Record<string, string>)["Idempotency-Key"];
    expect(firstKey).toBe(providerEmailIdempotencyKey("tenant-1", logicalKey));
    expect(secondKey).toBe(providerEmailIdempotencyKey("tenant-2", logicalKey));
    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).toHaveLength(77);
    expect(secondKey).toHaveLength(77);
  });

  it("replays the queued provider bytes after provider success and local finalization failure", async () => {
    const outboxStore: MockOutboxStore = { current: null };
    const rpcFailureCounts = { finalize_idempotent_email_send: 1 };
    const db = makeDb({
      outboxStore,
      rpcFailureCounts,
      rpcErrors: { finalize_idempotent_email_send: { message: "commit interrupted" } },
    });
    const beforeDispatch = vi.fn(async (_context: { providerReplay: boolean }) => ({ allowed: true }));
    const firstInput: SendEmailInput = {
      db,
      tenant: baseTenant,
      to: "first@example.com",
      subject: "Original subject",
      template_id: "test_template",
      category: "transactional",
      html: "<p>Original body</p>",
      idempotencyKey: "pre_cruise:booking-1:t_7",
      beforeDispatch,
    };

    await expect(sendEmail(firstInput)).rejects.toThrow(/finalize_idempotent_email_send/);
    const recovered = await sendEmail({
      ...firstInput,
      tenant: {
        ...baseTenant,
        email_from_name: "Changed Agency",
        email_from_address: "changed@example.com",
      },
      to: "changed@example.com",
      subject: "Changed subject",
      html: "<p>Changed body</p>",
    });

    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]?.body).toBe(calls[0]?.[1]?.body);
    expect(
      (calls[1]?.[1]?.headers as Record<string, string>)["Idempotency-Key"],
    ).toBe((calls[0]?.[1]?.headers as Record<string, string>)["Idempotency-Key"]);
    expect(beforeDispatch.mock.calls.map(([context]) => context)).toEqual([
      { providerReplay: false },
      { providerReplay: true },
    ]);
    expect(recovered).toMatchObject({
      status: "sent",
      email_log_id: "log-1",
      resend_message_id: "resend-msg-123",
    });
    expect(outboxStore.current).toMatchObject({
      status: "sent",
      resend_message_id: "resend-msg-123",
    });
  });

  it("runs the caller guard at the final boundary and does not call Resend when it rejects", async () => {
    const beforeDispatch = vi.fn(async () => ({ allowed: false, reason: "booking_cancelled" }));
    const db = makeDb();
    const result = await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Test Subject",
      template_id: "test_template",
      category: "transactional",
      html: testHtml,
      beforeDispatch,
    });

    expect(result).toEqual({ status: "cancelled", reason: "booking_cancelled" });
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fails loudly after provider success when atomic finalization fails so the keyed call can retry", async () => {
    const db = makeDb({ rpcErrors: { finalize_idempotent_email_send: { message: "database unavailable" } } });
    await expect(sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Test Subject",
      template_id: "test_template",
      category: "transactional",
      html: testHtml,
      idempotencyKey: "pre_cruise:booking-1:t_7",
    })).rejects.toThrow(/finalize_idempotent_email_send/);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("re-runs the email state transition on a recovered keyed send", async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const db = makeDb({ rpcCalls });
    const input: SendEmailInput = {
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Test Subject",
      template_id: "test_template",
      category: "transactional",
      html: testHtml,
      idempotencyKey: "pre_cruise:booking-1:t_7",
    };

    await sendEmail(input);
    await sendEmail(input);

    expect(rpcCalls.map((call) => call.name)).toEqual([
      "prepare_idempotent_email_send",
      "start_idempotent_email_dispatch",
      "finalize_idempotent_email_send",
      "finalize_idempotent_email_send",
    ]);
    expect(mocks.transitions).toHaveLength(2);
  });

  it("fails loudly when the post-RPC state transition is interrupted so recovery can heal it", async () => {
    mocks.transitionError = new Error("transition interrupted");
    const db = makeDb();
    await expect(sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Test Subject",
      template_id: "test_template",
      category: "transactional",
      html: testHtml,
      idempotencyKey: "pre_cruise:booking-1:t_7",
    })).rejects.toThrow(/transition interrupted/);
  });

  it("does not create retry content for a keyed retry_of send", async () => {
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const db = makeDb({ rpcCalls });
    await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Retry",
      template_id: "retry_template",
      category: "transactional",
      html: testHtml,
      idempotencyKey: "soft-retry:original:1",
      retry_of: "original-log-id",
    });

    expect(rpcCalls[0]?.args).toMatchObject({
      p_log: { retry_of: "original-log-id" },
      p_retry_content: null,
    });
  });

  it("omits the Idempotency-Key header when no idempotencyKey is given", async () => {
    const db = makeDb();
    await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Test Subject",
      template_id: "test_template",
      category: "transactional",
      html: testHtml,
    });
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    const headers = calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("#1611: an original send stores the rendered payload in email_retry_content for a soft-bounce re-send", async () => {
    const retryContentInserts: Record<string, unknown>[] = [];
    const db = makeDb({ retryContentInserts });
    await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Your cruise awaits",
      template_id: "pre_cruise_t_7",
      category: "pre_cruise",
      html: testHtml,
    });
    expect(retryContentInserts).toHaveLength(1);
    const stored = retryContentInserts[0]!;
    // Fidelity: exactly what we sent must be re-sendable verbatim (option a).
    expect(stored.html).toBe(testHtml);
    expect(stored.subject).toBe("Your cruise awaits");
    expect(stored.to_email).toBe("customer@example.com");
    expect(stored.email_category).toBe("pre_cruise");
    expect(stored.email_log_id).toBe("log-1");
    expect(stored.expires_at).toBeTypeOf("string"); // PII TTL set
  });

  it("#1611: a re-send (retry_of set) stamps email_log.retry_of and does NOT store its own retry content", async () => {
    const retryContentInserts: Record<string, unknown>[] = [];
    const logInserts: Record<string, unknown>[] = [];
    const db = makeDb({ retryContentInserts, logInserts });
    await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Your cruise awaits",
      template_id: "pre_cruise_t_7",
      category: "pre_cruise",
      html: testHtml,
      retry_of: "orig-log-1",
    });
    // No new retry chain / no duplicate stored payload for a re-send.
    expect(retryContentInserts).toHaveLength(0);
    // The re-send row is marked so the webhook won't start a fresh chain.
    expect(logInserts).toHaveLength(1);
    expect(logInserts[0]!.retry_of).toBe("orig-log-1");
  });

  it("returns failed when RESEND_API_KEY is not set", async () => {
    delete process.env.RESEND_API_KEY;
    const db = makeDb();
    const result = await sendEmail({
      db,
      tenant: baseTenant,
      to: "customer@example.com",
      subject: "Test",
      template_id: "t",
      category: "transactional",
      html: testHtml,
    });
    expect(result.status).toBe("failed");
    expect(result.reason).toMatch(/platform_resend_key_not_set/);
  });
});
