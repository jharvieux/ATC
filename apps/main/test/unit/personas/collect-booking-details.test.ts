// §9.6 — collect_booking_details handler.
//
// Contracts pinned here:
//   1. Creates a draft booking and returns booking_id + booking_url.
//   2. When primary_guest.date_of_birth is provided: inserts lead passenger
//      and returns a stage-2 URL (passenger confirmation step).
//   3. When date_of_birth is absent: skips passenger insert, returns stage-1 URL.
//   4. Returns invalid_input (was_mutating=false) for missing required fields.
//   5. Returns invalid_input for a malformed date_of_birth (not YYYY-MM-DD).
//   6. Throws (surfaces as tool_handler_failed via dispatchTool) when
//      bookings.insert returns a DB error.
//   7. Throws when booking_passengers.insert (via safeAwait) returns a DB error.
//   8. was_mutating = true on any successful path.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolDispatchContext } from "@/lib/personas/tools/dispatch";
import type { TenantContext } from "@/lib/db/tenant-context";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const BOOKING_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CONTACT_ID = "99999999-8888-7777-6666-555555555555";

const mocks = vi.hoisted(() => ({
  bookingInsertSingle: vi.fn(),
  passengerInsert: vi.fn(),
}));

function makeThenableInsert(fn: (...args: unknown[]) => unknown) {
  return function insert(_payload: unknown) {
    const p = fn(_payload);
    return {
      select: () => ({ single: () => p }),
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        Promise.resolve(p).then(resolve, reject),
    };
  };
}

vi.mock("@/lib/db/safe-mutation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/safe-mutation")>(
    "@/lib/db/safe-mutation",
  );
  return actual;
});

function makeDb(
  bookingResult: { data: { id: string } | null; error: null | { message: string; code?: string; hint?: string | null; details?: string | null; name?: string } },
  passengerResult: { error: null | { message: string; code?: string; hint?: string | null; details?: string | null; name?: string } } = { error: null },
) {
  mocks.bookingInsertSingle.mockResolvedValue(bookingResult);
  mocks.passengerInsert.mockResolvedValue(passengerResult);

  return {
    from: (table: string) => {
      if (table === "bookings") {
        return { insert: makeThenableInsert(mocks.bookingInsertSingle) };
      }
      if (table === "booking_passengers") {
        return {
          insert: (_payload: unknown) => {
            const p = mocks.passengerInsert(_payload);
            return {
              then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
                Promise.resolve(p).then(resolve, reject),
            };
          },
        };
      }
      return {};
    },
  } as unknown as ToolDispatchContext["db"];
}

function makeCtx(): ToolDispatchContext {
  const ctx: TenantContext = {
    tenant_id: TENANT_ID,
    source: { kind: "http_request", user_id: "u1" },
  };
  return {
    ctx,
    db: makeDb({ data: { id: BOOKING_ID }, error: null }),
    conversation_id: "cccccccc-dddd-eeee-ffff-000000000000",
    contact_id: CONTACT_ID,
  };
}

const baseInput = {
  quote_id: "q-abc-123",
  primary_guest: {
    first_name: "Jane",
    last_name: "Doe",
    date_of_birth: "1985-04-20",
  },
  special_requests: "Vegetarian meals please",
};

let handler: typeof import("@/lib/personas/tools/handlers/collect-booking-details").collectBookingDetails;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ collectBookingDetails: handler } = await import(
    "@/lib/personas/tools/handlers/collect-booking-details"
  ));
});

describe("collect_booking_details", () => {
  it("creates booking + pre-fills passenger + returns stage-2 URL when DOB provided", async () => {
    const dispatchCtx = makeCtx();
    const result = await handler(baseInput, dispatchCtx);
    const body = JSON.parse(result.content) as {
      ok: boolean;
      booking_id: string;
      booking_url: string;
      message: string;
    };
    expect(result.was_mutating).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.booking_id).toBe(BOOKING_ID);
    expect(body.booking_url).toBe(`/booking/flow/${BOOKING_ID}/2`);
    expect(mocks.passengerInsert).toHaveBeenCalledTimes(1);
  });

  it("skips passenger insert + returns stage-1 URL when DOB is absent", async () => {
    const dispatchCtx = makeCtx();
    const input = {
      quote_id: "q-abc-123",
      primary_guest: { first_name: "Jane", last_name: "Doe" },
    };
    const result = await handler(input, dispatchCtx);
    const body = JSON.parse(result.content) as { booking_url: string };
    expect(result.was_mutating).toBe(true);
    expect(body.booking_url).toBe(`/booking/flow/${BOOKING_ID}/1`);
    expect(mocks.passengerInsert).not.toHaveBeenCalled();
  });

  it("returns invalid_input (was_mutating=false) when first_name is missing", async () => {
    const dispatchCtx = makeCtx();
    const result = await handler(
      { quote_id: "q1", primary_guest: { last_name: "Doe" } },
      dispatchCtx,
    );
    const body = JSON.parse(result.content) as { error: string };
    expect(result.was_mutating).toBe(false);
    expect(body.error).toBe("invalid_input");
    expect(mocks.bookingInsertSingle).not.toHaveBeenCalled();
  });

  it("returns invalid_input when date_of_birth is malformed", async () => {
    const dispatchCtx = makeCtx();
    const result = await handler(
      {
        quote_id: "q1",
        primary_guest: { first_name: "Jane", last_name: "Doe", date_of_birth: "20-04-1985" },
      },
      dispatchCtx,
    );
    expect(result.was_mutating).toBe(false);
    expect(JSON.parse(result.content).error).toBe("invalid_input");
  });

  it("succeeds when quote_id is omitted — column not yet in DB", async () => {
    const dispatchCtx = makeCtx();
    const result = await handler(
      { primary_guest: { first_name: "Jane", last_name: "Doe" } },
      dispatchCtx,
    );
    expect(result.was_mutating).toBe(true);
    expect(JSON.parse(result.content).ok).toBe(true);
  });

  it("throws when bookings.insert returns a DB error", async () => {
    // makeCtx() must come first — makeDb() call order determines which mock value wins
    const baseCtx = makeCtx();
    const db = makeDb({
      data: null,
      error: { message: "permission denied", code: "42501", hint: null, details: null, name: "PostgrestError" },
    });
    await expect(handler(baseInput, { ...baseCtx, db })).rejects.toThrow("bookings.insert failed");
  });

  it("throws (via safeAwait) when booking_passengers.insert returns a DB error", async () => {
    const baseCtx = makeCtx();
    const db = makeDb(
      { data: { id: BOOKING_ID }, error: null },
      { error: { message: "constraint violation", code: "23502", hint: null, details: null, name: "PostgrestError" } },
    );
    await expect(handler(baseInput, { ...baseCtx, db })).rejects.toThrow("booking_passengers.insert");
  });
});
