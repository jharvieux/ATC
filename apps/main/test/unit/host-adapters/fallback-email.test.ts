// #1681 — regression coverage for FallbackEmailAdapter.submitBooking, whose
// money lines changed from "12.34 USD" to a currency-formatted "$12.34" in
// #1657 with zero test protection. These tests pin the email body format so a
// future edit to the formatter (or a revert to the old "amount CODE" shape)
// fails loudly instead of silently degrading the manual-processing email a
// tenant admin reads to fulfil the booking.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BookingSubmissionRequest, HostCallContext } from "@atc/shared-types";

let mockEnv: Record<string, string | undefined> = {};
vi.mock("@/lib/env", () => ({
  env: () => mockEnv,
}));

const FallbackEmailAdapter = (await import("@/lib/host-adapters/fallback-email/adapter")).default;

function configuredEnv() {
  return {
    HOST_ADAPTER_FALLBACK_EMAIL_TO: "ops@example.com",
    HOST_ADAPTER_FALLBACK_EMAIL_FROM: "no-reply@example.com",
    RESEND_API_KEY: "re_test_key",
  };
}

function booking(overrides: Partial<BookingSubmissionRequest> = {}): BookingSubmissionRequest {
  return {
    contact_id: "contact-1",
    cruise_line: "Norwegian",
    ship_name: "Bliss",
    sailing_date: "2026-09-01",
    duration_nights: 7,
    cabin_category: "Balcony",
    passengers: [{ first_name: "Ada", last_name: "Lovelace" }],
    commissionable_fare_cents: 9900,
    total_amount_cents: 123456,
    currency: "USD",
    ...overrides,
  };
}

const ctx: HostCallContext = {
  tenant_id: "tenant-42",
  user_id: "user-1",
  correlation_id: "corr-abc",
};

// Capture the outbound Resend request so we can assert the rendered email body.
let capturedBody: { text: string; subject: string } | null = null;
const fetchMock = vi.fn(async (_url: string, init?: { body?: string }) => {
  capturedBody = init?.body ? JSON.parse(init.body) : null;
  return { ok: true, status: 200, text: async () => "" } as Response;
});

beforeEach(() => {
  mockEnv = configuredEnv();
  capturedBody = null;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FallbackEmailAdapter.submitBooking — money format (#1681)", () => {
  it("renders money lines as currency strings ($X.XX), not the old 'amount CODE' shape", async () => {
    const adapter = new FallbackEmailAdapter();
    const result = await adapter.submitBooking(booking(), ctx);

    expect(result.ok).toBe(true);
    expect(capturedBody).not.toBeNull();
    const text = capturedBody!.text;

    // total_amount_cents 123456 → "$1,234.56"; commissionable 9900 → "$99.00".
    expect(text).toContain("Total Amount: $1,234.56");
    expect(text).toContain("Commissionable Fare: $99.00");
    // The pre-#1657 format ("1234.56 USD") must not reappear.
    expect(text).not.toMatch(/Total Amount: 1234\.56 USD/);
  });

  it("returns a synthetic provider_booking_ref scoped to the tenant", async () => {
    const adapter = new FallbackEmailAdapter();
    const result = await adapter.submitBooking(booking(), ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.provider_booking_ref).toMatch(/^EMAIL-tenant-42-\d+$/);
    }
  });

  it("fails closed (host_unavailable) when email routing is not configured", async () => {
    mockEnv = { ...configuredEnv(), RESEND_API_KEY: undefined };
    const adapter = new FallbackEmailAdapter();
    const result = await adapter.submitBooking(booking(), ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("host_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
