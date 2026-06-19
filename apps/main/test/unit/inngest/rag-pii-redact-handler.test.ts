// §22.4 Stage 2 — redactSubmission (the zero-tolerance quarantine gate).
//
// The privacy invariant: zero-tolerance PII (SSN / credit card / passport) MUST
// quarantine the submission and MUST NOT reach the Haiku enqueue. Empty content
// quarantines; clean content enqueues. A mutation that lets PII through to the
// enqueue path must fail here.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { enqueueMock, payMock } = vi.hoisted(() => ({
  enqueueMock: vi.fn(),
  payMock: vi.fn(),
}));

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, fn: unknown) => fn,
    send: async () => {},
  },
}));
vi.mock("@/lib/ai/batch/enqueue", () => ({ enqueueBatchRequest: enqueueMock }));
vi.mock("@/lib/billing/exclude-non-paying", () => ({ assertTenantStillPayingById: payMock }));

import { redactSubmission } from "@/inngest/rag-pii-redact";

const TENANT = "11111111-2222-3333-4444-555555555555";
const SUBMISSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeDb(extractedContent: string | null) {
  const submissionUpdates: Array<Record<string, unknown>> = [];
  const db = {
    from: (table: string) => {
      if (table === "rag_submissions") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: extractedContent !== null ? { extracted_content: extractedContent } : null,
                  error: null,
                }),
              }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: () => {
              submissionUpdates.push(patch);
              return Promise.resolve({ data: null, error: null });
            },
          }),
        };
      }
      // tenants — used by runAggregationAndAlert
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                pii_quarantine_alert_window_start: null,
                pii_quarantine_alert_count_in_window: 0,
                pii_quarantine_recurring_days: 0,
                pii_quarantine_last_event_at: null,
              },
              error: null,
            }),
          }),
        }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
    },
  } as unknown as ReturnType<typeof import("@/lib/db/service-role-client").createServiceRoleClient>;
  return { db, submissionUpdates };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  payMock.mockResolvedValue({ ok: true });
  enqueueMock.mockResolvedValue({ request_id: "req-1" });
});

describe("redactSubmission — zero-tolerance quarantine gate (#1217)", () => {
  it("skips a past-grace tenant without touching the submission or the enqueue", async () => {
    payMock.mockResolvedValue({ ok: false, reason: "past_grace" });
    const { db, submissionUpdates } = makeDb("Hello from Alice");

    const res = await redactSubmission({ db, tenant_id: TENANT, submission_id: SUBMISSION });

    expect(res).toMatchObject({ skipped: true });
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(submissionUpdates).toHaveLength(0);
  });

  it("quarantines when there is no extracted content; never enqueues", async () => {
    const { db, submissionUpdates } = makeDb(null);

    const res = await redactSubmission({ db, tenant_id: TENANT, submission_id: SUBMISSION });

    expect(res).toMatchObject({ ok: false, reason: "no_extracted_content" });
    expect(submissionUpdates[0]).toMatchObject({
      pii_redaction_status: "quarantined",
      quarantine_categories: ["empty_content"],
    });
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("QUARANTINES zero-tolerance PII (SSN) and NEVER reaches the Haiku enqueue", async () => {
    const { db, submissionUpdates } = makeDb("Booking note — traveler SSN 123-45-6789 on file.");

    const res = await redactSubmission({ db, tenant_id: TENANT, submission_id: SUBMISSION });

    expect(res).toMatchObject({ ok: true, quarantined: true });
    expect((res as { categories: string[] }).categories).toContain("ssn");
    expect(submissionUpdates[0]).toMatchObject({ pii_redaction_status: "quarantined" });
    // The whole point: detected PII must not be forwarded to the redaction LLM.
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("quarantines a Luhn-valid credit card", async () => {
    const { db } = makeDb("card on file 4111 1111 1111 1111 for the deposit");
    const res = await redactSubmission({ db, tenant_id: TENANT, submission_id: SUBMISSION });
    expect(res).toMatchObject({ ok: true, quarantined: true });
    expect((res as { categories: string[] }).categories).toContain("credit_card");
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("enqueues clean content for tolerable-PII redaction (not quarantined)", async () => {
    const { db, submissionUpdates } = makeDb("Norwegian Bliss sails from Seattle to Alaska in July.");

    const res = await redactSubmission({ db, tenant_id: TENANT, submission_id: SUBMISSION });

    expect(res).toMatchObject({ ok: true, enqueued: true, request_id: "req-1" });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    // Clean content is left pending for the consumer — not quarantined here.
    expect(submissionUpdates).toHaveLength(0);
  });
});
