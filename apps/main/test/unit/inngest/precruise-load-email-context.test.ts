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
          const maybeSingle = async () => {
            if (table === "bookings") {
              return {
                data: {
                  id: "b1",
                  tenant_id: "t1",
                  group_booking_id: "g1",
                  user_id: "u1",
                  primary_contact_id: "contact-1",
                  groups: mocks.groupsRow,
                },
                error: null,
              };
            }
            if (table === "contacts") {
              // #1190: recipient name + email come from the booking's contact.
              return { data: { first_name: "Jordan", email: "jordan@example.com" }, error: null };
            }
            if (table === "tenants") {
              return { data: { id: "t1", legal_name: "Anchor & Compass" }, error: null };
            }
            // tenant_branding — #1190: email send config lives here.
            return {
              data: {
                email_send_pattern: "tenant_resend",
                tenant_resend_api_key_encrypted: "enc-key",
                email_from_address: "concierge@tenant.com",
                email_from_name: "Tenant Concierge",
              },
              error: null,
            };
          };
          // Support both .eq().maybeSingle() and .eq().eq().maybeSingle().
          const chain: { eq: () => typeof chain; maybeSingle: typeof maybeSingle } = {
            eq: () => chain,
            maybeSingle,
          };
          return chain;
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
    const bookingsSelect = mocks.selectArgs.find((s) => s.includes("primary_contact_id"));
    expect(bookingsSelect).toBeDefined();
    expect(bookingsSelect).toContain("departure_port)");
    expect(bookingsSelect).toContain("group_booking_id");
    // The bug — these never existed on bookings and must never come back:
    expect(bookingsSelect).not.toContain("customer_name");
    expect(bookingsSelect).not.toContain("passenger_contact_email");
    expect(bookingsSelect).not.toContain("departure_port_code");
    expect(bookingsSelect).not.toContain("itinerary_ports");
  });

  it("#1190: recipient name (first name only) + email come from the booking's contact", async () => {
    const ctx = await loadEmailContext({
      svc: createServiceRoleClient(),
      booking_id: "b1",
      tenant_id: "t1",
      phase: "t_1",
    });
    expect(ctx?.toEmail).toBe("jordan@example.com");
    expect(ctx?.customerName).toBe("Jordan");
    // The contact must be looked up (no customer_name/email on bookings).
    expect(mocks.selectArgs.some((s) => s.includes("first_name, email"))).toBe(true);
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

  it("#1190: reads tenant email send config from tenant_branding, not tenants", async () => {
    const ctx = await loadEmailContext({
      svc: createServiceRoleClient(),
      booking_id: "b1",
      tenant_id: "t1",
      phase: "t_1",
    });
    // Email config must flow from the branding row.
    expect(ctx?.branding.email_send_pattern).toBe("tenant_resend");
    expect(ctx?.branding.email_from_address).toBe("concierge@tenant.com");
    // The tenants SELECT must not carry the email columns (they don't exist there).
    const tenantsSelect = mocks.selectArgs.find((s) => s.startsWith("id, legal_name"));
    expect(tenantsSelect).toBeDefined();
    expect(tenantsSelect).not.toContain("email_send_pattern");
    // The tenant_branding SELECT must carry them.
    const brandingSelect = mocks.selectArgs.find((s) => s.includes("logo_url"));
    expect(brandingSelect).toContain("email_send_pattern");
    expect(brandingSelect).toContain("email_from_address");
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
