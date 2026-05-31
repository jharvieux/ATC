// §23.4 — loadEmailContext data-access shape (regression guard for #483).
//
// The bug: the bookings→groups SELECT referenced `departure_port_code`
// and `itinerary_ports`, which don't exist on the `groups` table. The
// real column is `departure_port`. These tests pin the corrected SELECT
// so the phantom columns can't silently creep back — and assert that
// the departure port flows through to the email context while the ports
// list stays empty (per-stop itinerary isn't captured until #485).

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  selectArgs: [] as string[],
  groupsRow: {
    cruise_line: "Norwegian Cruise Line",
    ship_name: "Norwegian Bliss",
    sailing_date: "2026-08-28",
    departure_port: "Miami, FL",
  } as Record<string, unknown> | null,
}));

// Capture every .select(arg) string so we can assert the bookings query
// shape. Each table returns a canned row appropriate to the caller.
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(table: string) {
      return {
        select(arg: string) {
          mocks.selectArgs.push(arg);
          return {
            eq() {
              return {
                maybeSingle: async () => {
                  if (table === "bookings") {
                    return {
                      data: {
                        id: "b1",
                        tenant_id: "t1",
                        group_id: "g1",
                        customer_name: "Jordan",
                        passenger_contact_email: "jordan@example.com",
                        groups: mocks.groupsRow,
                      },
                      error: null,
                    };
                  }
                  if (table === "tenants") {
                    return { data: { id: "t1", legal_name: "Anchor & Compass" }, error: null };
                  }
                  // tenant_branding
                  return { data: {}, error: null };
                },
              };
            },
          };
        },
      };
    },
  }),
}));

vi.mock("@/lib/email/unsubscribe-token", () => ({
  signCompanionToken: () => "companion-token",
  signUnsubscribeToken: () => "unsub-token",
}));

import { loadEmailContext } from "@/inngest/precruise-generate-and-send";
import { createServiceRoleClient } from "@/lib/db/service-role-client";

beforeEach(() => {
  mocks.selectArgs = [];
  mocks.groupsRow = {
    cruise_line: "Norwegian Cruise Line",
    ship_name: "Norwegian Bliss",
    sailing_date: "2026-08-28",
    departure_port: "Miami, FL",
  };
});

describe("loadEmailContext — bookings SELECT shape (#483)", () => {
  it("selects groups.departure_port and NOT the phantom columns", async () => {
    await loadEmailContext({
      svc: createServiceRoleClient(),
      booking_id: "b1",
      tenant_id: "t1",
      phase: "t_1",
    });
    const bookingsSelect = mocks.selectArgs.find((s) => s.includes("passenger_contact_email"));
    expect(bookingsSelect).toBeDefined();
    expect(bookingsSelect).toContain("departure_port)");
    // The bug — these must never come back:
    expect(bookingsSelect).not.toContain("departure_port_code");
    expect(bookingsSelect).not.toContain("itinerary_ports");
  });

  it("maps groups.departure_port to ctx.departurePort", async () => {
    const ctx = await loadEmailContext({
      svc: createServiceRoleClient(),
      booking_id: "b1",
      tenant_id: "t1",
      phase: "t_1",
    });
    expect(ctx?.departurePort).toBe("Miami, FL");
  });

  it("leaves ports empty until #485 captures per-stop itinerary", async () => {
    const ctx = await loadEmailContext({
      svc: createServiceRoleClient(),
      booking_id: "b1",
      tenant_id: "t1",
      phase: "t_90",
    });
    expect(ctx?.ports).toEqual([]);
  });

  it("omits departurePort when groups has none (no crash)", async () => {
    mocks.groupsRow = {
      cruise_line: "NCL",
      ship_name: "Bliss",
      sailing_date: "2026-08-28",
      // no departure_port
    };
    const ctx = await loadEmailContext({
      svc: createServiceRoleClient(),
      booking_id: "b1",
      tenant_id: "t1",
      phase: "t_1",
    });
    expect(ctx?.departurePort).toBeUndefined();
  });
});
