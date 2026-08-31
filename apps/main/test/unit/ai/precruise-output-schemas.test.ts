// #2009 — the batched precruise path relies on provider-constrained
// structured output (output_config.format json_schema) instead of
// prompt-begging + fence/brace slicing. Two contracts are load-bearing:
//
// 1. Schema validity: Anthropic rejects (400) any object schema without
//    additionalProperties:false or with a partial `required` list. A
//    drifted schema would fail every batched precruise email at submit.
// 2. Schema ↔ renderer sync: buildEmail / precruiseAiContentText index
//    these exact keys per phase. A key generated but not rendered is paid
//    for and dropped; a key rendered but not generated silently blanks a
//    section of the customer email. This test forces both edits together.
//
// Plus the wiring: the via:"batched" branch must actually attach the
// phase schema to the enqueued request — without it the strict parser
// downstream rejects everything.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: unknown) => handler,
  },
}));

const mocks = vi.hoisted(() => ({
  enqueueCalls: [] as Array<Record<string, unknown>>,
  sendEmailCalls: 0,
}));

vi.mock("@/lib/billing/exclude-non-paying", () => ({
  assertTenantStillPayingById: async () => ({ ok: true }),
}));

vi.mock("@/lib/ai/call-wrapper", () => ({
  instrumentedClaudeCall: async () => ({ text: "unused" }),
}));

vi.mock("@/lib/ai/batch/enqueue", () => ({
  enqueueBatchRequest: async (args: Record<string, unknown>) => {
    mocks.enqueueCalls.push(args);
    return { request_id: "req-1", enqueued_at: new Date().toISOString() };
  },
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
      if (table === "pre_cruise_email_content") {
        return {
          select() {
            const chain = {
              eq: () => chain,
              maybeSingle: async () => ({ data: null, error: null }), // not yet sent
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
            maybeSingle: async () => ({ data: {}, error: null }),
          };
          return chain;
        },
      };
    },
  }),
}));

import {
  precruiseGenerateAndSend,
  PRECRUISE_OUTPUT_SCHEMAS,
} from "@/inngest/precruise-generate-and-send";

// The exact key sets buildEmail (email renderer props) and
// precruiseAiContentText ({{ai_content}} flattening) consume per phase.
// Change those consumers → change this list → change the schema, together.
const RENDERED_KEYS: Record<string, string[]> = {
  t_90: ["documentation_reminder", "destination_teaser", "must_do_experiences", "did_you_know", "suggested_reads"],
  t_30: [
    "reservation_reminders",
    "checkin_window",
    "final_payment_note",
    "personalized_recommendations",
    "specialty_experiences",
    "pack_inspiration",
  ],
  t_7: ["packing_checklist", "ship_highlights", "cruise_line_tips", "embarkation_advice", "first_day_inspiration"],
  t_1: ["first_port_preview", "day_of_expectations"],
};

beforeEach(() => {
  mocks.enqueueCalls = [];
  mocks.sendEmailCalls = 0;
});

describe("PRECRUISE_OUTPUT_SCHEMAS — Anthropic structured-output validity", () => {
  for (const [phase, schema] of Object.entries(PRECRUISE_OUTPUT_SCHEMAS)) {
    it(`${phase}: object schema with additionalProperties:false and every property required`, () => {
      const s = schema as { type: string; additionalProperties: boolean; required: string[]; properties: Record<string, unknown> };
      expect(s.type).toBe("object");
      // Anthropic hard requirement — a missing additionalProperties:false 400s the whole batch.
      expect(s.additionalProperties).toBe(false);
      expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
    });

    it(`${phase}: schema keys match what the email renderer consumes`, () => {
      const s = schema as { properties: Record<string, unknown> };
      expect(Object.keys(s.properties).sort()).toEqual([...RENDERED_KEYS[phase]!].sort());
    });
  }

  it("t_30 generates specialty experiences instead of defining a dead field", () => {
    const schema = PRECRUISE_OUTPUT_SCHEMAS.t_30 as {
      properties: { specialty_experiences: { description: string } };
    };
    expect(schema.properties.specialty_experiences.description).toContain("Exactly 3");
    expect(schema.properties.specialty_experiences.description).not.toContain("empty array");
  });
});

describe("precruiseGenerateAndSend via:'batched' — schema wiring", () => {
  it("enqueues the batch request with the phase's json_schema output constraint and does not send", async () => {
    await (precruiseGenerateAndSend as unknown as (args: { event: { data: unknown } }) => Promise<void>)({
      event: { data: { booking_id: "b1", tenant_id: "t1", phase: "t_90", via: "batched" } },
    });

    expect(mocks.sendEmailCalls).toBe(0);
    expect(mocks.enqueueCalls).toHaveLength(1);
    const params = (mocks.enqueueCalls[0] as { request_params: Record<string, unknown> }).request_params;
    expect(params.output_config).toEqual({
      format: { type: "json_schema", schema: PRECRUISE_OUTPUT_SCHEMAS.t_90 },
    });
  });
});
