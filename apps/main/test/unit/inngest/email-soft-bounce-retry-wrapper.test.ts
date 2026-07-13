// #1831 — pins the deterministic Inngest event id the WRAPPER builds for
// scheduleNext (email-soft-bounce-retry.test.ts covers only the pure lib
// logic, stubbing scheduleNext below the wrapper that actually constructs the
// id string). Intent: soft-retry:<log>:attempt:<n> must match, character for
// character, the format the webhook route uses for the initial send
// (resend-route.test.ts) — a typo or dropped field here reopens the
// concurrent-duplicate race that the completed_attempt marker alone doesn't
// cover, and Inngest silently drops the wrong-id event instead of erroring.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInngestSend = vi.fn().mockResolvedValue(undefined);
vi.mock("@/inngest/client", () => ({
  inngest: {
    send: (...args: unknown[]) => mockInngestSend(...args),
    createFunction: (config: unknown, handler: unknown) => ({ config, handler }),
  },
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({}),
}));

vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn() }));

// The pure engine's own scheduleNext-invocation logic is already covered by
// email-soft-bounce-retry.test.ts; here we only need to exercise the id the
// WRAPPER's scheduleNext closure builds, so stub the engine to just call it.
vi.mock("@/lib/email/soft-bounce-retry", () => ({
  runSoftBounceRetryAttempt: async (
    deps: { scheduleNext: (p: { email_log_id: string; tenant_id: string; attempt: number }) => Promise<void> },
    payload: { email_log_id: string; tenant_id: string; attempt: number },
  ) => {
    await deps.scheduleNext({ ...payload, attempt: payload.attempt + 1 });
    return "resent";
  },
}));

import { emailSoftBounceRetry } from "@/inngest/email-soft-bounce-retry";

type RawHandler = {
  handler: (args: {
    event: { data: unknown };
    step: { sleep: (...a: unknown[]) => Promise<void>; run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> };
  }) => Promise<unknown>;
};

beforeEach(() => {
  mockInngestSend.mockClear();
});

describe("#1831 — wrapper's scheduleNext deterministic event id", () => {
  it("builds soft-retry:<log>:attempt:<n> for the NEXT attempt", async () => {
    const fn = emailSoftBounceRetry as unknown as RawHandler;
    await fn.handler({
      event: { data: { email_log_id: "log-9", tenant_id: "tenant-1", attempt: 1 } },
      step: { sleep: vi.fn(), run: (_id, f) => f() },
    });

    expect(mockInngestSend).toHaveBeenCalledOnce();
    expect(mockInngestSend).toHaveBeenCalledWith({
      id: "soft-retry:log-9:attempt:2",
      name: "email/soft.bounce.retry",
      data: { email_log_id: "log-9", tenant_id: "tenant-1", attempt: 2 },
    });
  });

  it("uses the SAME id format as the webhook's initial send (soft-retry:<log>:attempt:<n>)", async () => {
    // The webhook's initial send (resend-route.test.ts) pins
    // "soft-retry:log-1:attempt:1" for attempt 1. Drive attempt 1 here and
    // confirm the wrapper's scheduleNext id template matches exactly, so the
    // two independently-maintained id-builders can't silently drift apart.
    const fn = emailSoftBounceRetry as unknown as RawHandler;
    await fn.handler({
      event: { data: { email_log_id: "log-1", tenant_id: "tenant-1", attempt: 0 } },
      step: { sleep: vi.fn(), run: (_id, f) => f() },
    });

    expect(mockInngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ id: "soft-retry:log-1:attempt:1" }),
    );
  });
});
