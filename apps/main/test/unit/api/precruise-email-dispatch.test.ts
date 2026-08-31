// §23.4 — staff manual pre-cruise dispatch must stay tenant-scoped and reuse
// the existing direct generation event for both immediate and future sends.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const BOOKING_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  assertPermission: vi.fn(),
  respondToAuthError: vi.fn(() => Response.json({ error: "forbidden" }, { status: 403 })),
  tenantClient: vi.fn(),
  send: vi.fn(),
  validateEvent: vi.fn(),
  booking: {
    id: "22222222-2222-4222-8222-222222222222",
    status: "confirmed",
    primary_contact_id: "contact-1",
    sailing_date: "2027-05-01",
    groups: null,
  } as {
    id: string;
    status: string;
    primary_contact_id: string | null;
    sailing_date: string | null;
    groups: { sailing_date: string | null } | null;
  } | null,
  contact: { email: "traveler@example.com" } as { email: string | null } | null,
  existing: null as { sent_at: string | null } | null,
}));

vi.mock("@/lib/auth/assert-permission", () => ({ assertPermission: mocks.assertPermission }));
vi.mock("@/lib/auth/respond", () => ({ respondToAuthError: mocks.respondToAuthError }));
vi.mock("@/inngest/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/lib/inngest/event-registry", () => ({ validateInngestEvent: mocks.validateEvent }));
vi.mock("@/lib/db/tenant-client", () => ({ tenantClient: mocks.tenantClient }));

import { POST } from "@/app/api/precruise-emails/dispatch/route";

function queryFor(table: string) {
  const result =
    table === "bookings"
      ? { data: mocks.booking, error: null }
      : table === "contacts"
        ? { data: mocks.contact, error: null }
        : { data: mocks.existing, error: null };
  const chain = {
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => result),
  };
  return { select: vi.fn(() => chain) };
}

function request(body: unknown): Request {
  return new Request("https://tenant.example.com/api/precruise-emails/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-31T18:00:00.000Z"));
  mocks.booking = {
    id: BOOKING_ID,
    status: "confirmed",
    primary_contact_id: "contact-1",
    sailing_date: "2027-05-01",
    groups: null,
  };
  mocks.contact = { email: "traveler@example.com" };
  mocks.existing = null;
  mocks.assertPermission.mockReset().mockResolvedValue({
    ctx: { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "auth-1" } },
    user: { id: "user-1", role: "agent" },
  });
  mocks.respondToAuthError.mockClear();
  mocks.send.mockReset().mockResolvedValue({ ids: ["event-1"] });
  mocks.validateEvent.mockClear();
  mocks.tenantClient.mockReset().mockImplementation((ctx) => {
    expect(ctx.tenant_id).toBe(TENANT_ID);
    return { from: (table: string) => queryFor(table) };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/precruise-emails/dispatch", () => {
  it("gates send-now with the send permission and emits the existing direct event", async () => {
    const response = await POST(request({ action: "send_now", booking_id: BOOKING_ID, phase: "t_30" }));

    expect(response.status).toBe(202);
    expect(mocks.assertPermission).toHaveBeenCalledWith(
      expect.any(Request),
      { resource: "precruise_emails", action: "send" },
    );
    expect(mocks.validateEvent).toHaveBeenCalledWith("precruise/email.due", {
      booking_id: BOOKING_ID,
      tenant_id: TENANT_ID,
      phase: "t_30",
      via: "direct",
    });
    expect(mocks.send).toHaveBeenCalledWith({
      id: expect.stringMatching(/^manual-precruise:/),
      name: "precruise/email.due",
      data: expect.objectContaining({ booking_id: BOOKING_ID, tenant_id: TENANT_ID, phase: "t_30", via: "direct" }),
    });
  });

  it("gates future delivery with the schedule permission and passes a durable timestamp", async () => {
    const scheduledFor = "2026-09-02T15:30:00.000Z";
    const response = await POST(request({
      action: "schedule",
      booking_id: BOOKING_ID,
      phase: "t_7",
      scheduled_for: scheduledFor,
    }));

    expect(response.status).toBe(202);
    expect(mocks.assertPermission).toHaveBeenCalledWith(
      expect.any(Request),
      { resource: "precruise_emails", action: "schedule" },
    );
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      ts: Date.parse(scheduledFor),
      data: expect.objectContaining({ phase: "t_7", via: "direct" }),
    }));
  });

  it("returns the authorization response without querying or dispatching", async () => {
    mocks.assertPermission.mockRejectedValue(new Error("forbidden"));
    const response = await POST(request({ action: "send_now", booking_id: BOOKING_ID, phase: "t_1" }));

    expect(response.status).toBe(403);
    expect(mocks.tenantClient).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("rejects past schedules before any booking lookup", async () => {
    const response = await POST(request({
      action: "schedule",
      booking_id: BOOKING_ID,
      phase: "t_90",
      scheduled_for: "2026-08-31T17:00:00.000Z",
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_schedule_time" });
    expect(mocks.tenantClient).not.toHaveBeenCalled();
  });

  it("refuses bookings that are not confirmed", async () => {
    mocks.booking = { ...mocks.booking!, status: "cancelled" };
    const response = await POST(request({ action: "send_now", booking_id: BOOKING_ID, phase: "t_1" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "booking_not_confirmed" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("accepts the sailing date from a linked group booking", async () => {
    mocks.booking = {
      ...mocks.booking!,
      sailing_date: null,
      groups: { sailing_date: "2027-05-01" },
    };
    const response = await POST(request({ action: "send_now", booking_id: BOOKING_ID, phase: "t_30" }));

    expect(response.status).toBe(202);
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it("refuses a phase already sent by either the automatic or manual path", async () => {
    mocks.existing = { sent_at: "2026-08-30T12:00:00.000Z" };
    const response = await POST(request({ action: "send_now", booking_id: BOOKING_ID, phase: "t_90" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "phase_already_sent" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("requires an address on the booking's primary contact", async () => {
    mocks.contact = { email: null };
    const response = await POST(request({ action: "send_now", booking_id: BOOKING_ID, phase: "t_7" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "recipient_missing" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
