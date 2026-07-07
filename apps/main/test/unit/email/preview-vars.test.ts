// #1608 — preview and send-preview MUST derive identical vars/layout for the
// same fixture. Both routes now call the same buildPreviewVars/layoutFromRows
// helpers; this test is the acceptance-criteria regression guard against a
// future fork reintroducing drift between the two routes.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildPreviewVars, layoutFromRows } from "@/lib/email/preview-vars";
import { EMAIL_TEMPLATE_REGISTRY } from "@/lib/email/template-registry";

const SAILING_FIXTURE = {
  departure_date: "2026-09-12",
  departure_port: "Miami, FL",
  cruise_ships: {
    canonical_name: "Wonder of the Seas",
    cruise_lines: { display_name: "Royal Caribbean" },
  },
};

const BOOKING_FIXTURE = {
  ship_name: "Mardi Gras",
  cruise_line: "Carnival",
  sailing_date: "2026-11-03",
  contacts: { first_name: "Sam", last_name: "Rivera" },
};

function makeDb(table: string, row: unknown): SupabaseClient {
  return {
    from: (t: string) => {
      if (t !== table) throw new Error(`unexpected table ${t}`);
      return { select: () => ({ eq: () => ({ single: async () => ({ data: row, error: null }) }) }) };
    },
  } as unknown as SupabaseClient;
}

describe("buildPreviewVars (#1608 preview/send-preview parity)", () => {
  const spec = EMAIL_TEMPLATE_REGISTRY.pre_cruise_t_90;

  it("resolves identical vars from a sailing_id fixture on every call", async () => {
    const db = makeDb("cruise_sailings", SAILING_FIXTURE);
    const previewCall = await buildPreviewVars(db, spec, "sail-1", null);
    const sendPreviewCall = await buildPreviewVars(db, spec, "sail-1", null);

    expect(sendPreviewCall).toEqual(previewCall);
    expect(previewCall).toEqual({
      ok: true,
      vars: expect.objectContaining({
        sailing_date: "2026-09-12",
        ship_name: "Wonder of the Seas",
        cruise_line: "Royal Caribbean",
      }),
    });
  });

  it("resolves identical vars from a booking_id fixture on every call", async () => {
    const db = makeDb("bookings", BOOKING_FIXTURE);
    const previewCall = await buildPreviewVars(db, spec, null, "booking-1");
    const sendPreviewCall = await buildPreviewVars(db, spec, null, "booking-1");

    expect(sendPreviewCall).toEqual(previewCall);
    expect(previewCall).toEqual({
      ok: true,
      vars: expect.objectContaining({
        ship_name: "Mardi Gras",
        cruise_line: "Carnival",
        sailing_date: "2026-11-03",
        customer_name: "Sam Rivera",
        recipient_name: "Sam Rivera",
        invitee_name: "Sam Rivera",
      }),
    });
  });

  it("falls back to registry sample vars with no sailing_id or booking_id", async () => {
    const result = await buildPreviewVars({} as SupabaseClient, spec, null, null);
    expect(result).toEqual({
      ok: true,
      vars: Object.fromEntries(spec.variables.map((v) => [v.name, v.sample])),
    });
  });
});

describe("layoutFromRows (#1608 BrandingRow drift fix)", () => {
  it("builds the same visual layout whether branding is the narrow preview shape or the wider send-preview shape (with send-pattern fields)", () => {
    const tenant = { legal_name: "Acme Cruises", mailing_address: "123 Main St" };
    const narrowBranding = {
      logo_url: "https://x.example/logo.png",
      primary_color: "#123456",
      secondary_color: "#654321",
      accent_color: "#abcdef",
      slogan: "Sail away",
    };
    // send-preview's BrandingRow is a superset (adds send-pattern/from-address
    // fields) — layoutFromRows must ignore them and produce identical output.
    const wideBranding = {
      ...narrowBranding,
      email_send_pattern: "tenant_resend" as const,
      tenant_resend_api_key_encrypted: "enc",
      email_from_address: "hello@acme.example",
      email_from_name: "Acme",
      email_from_domain: "acme.example",
      email_from_domain_verified_at: "2026-01-01T00:00:00Z",
    };

    expect(layoutFromRows(tenant, wideBranding)).toEqual(layoutFromRows(tenant, narrowBranding));
  });
});
