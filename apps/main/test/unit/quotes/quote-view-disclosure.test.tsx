// §20.7 (#1876) — the customer-facing quote acceptance page (q/[token]) must
// carry the tenant-of-record legal disclosure. This is the one wired surface
// that previously lacked a no-placeholder regression test.
//
// The derivation under test lives in CustomerQuoteViewPage:
//   disclosure = tenant?.display_name && hostLegalName ? {...} : null
//
// This pins:
// 1. Happy path — the disclosure renders the REAL sub-host display_name +
//    host-agency legal name (from platform_settings), never a placeholder.
// 2. Fail-closed — a missing host-agency legal name OR a missing tenant
//    display_name renders NO disclosure section, and NO placeholder string
//    appears anywhere in the output. The rest of the quote page still renders.
//
// Server-component render harness mirrors apps/main/test/unit/admin/supervisor-page.test.ts
// (mock createServiceRoleClient + renderToStaticMarkup(await Page())).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(),
  writeAuditLog: vi.fn(),
  headers: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: mocks.createServiceRoleClient,
}));
vi.mock("@/lib/audit/write", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
// Client sub-components are irrelevant to the disclosure derivation — stub them
// so the server render doesn't drag in client-only concerns. TenantOfRecordDisclosure
// is intentionally NOT mocked: we assert its real rendered output.
vi.mock("@/components/chat/PublicTokenChatPanel", () => ({
  PublicTokenChatPanel: () => null,
}));
vi.mock("@/components/branding/TenantTheme", () => ({ TenantTheme: () => null }));

import CustomerQuoteViewPage from "@/app/q/[token]/page";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const QUOTE_ID = "quote-1";

type QueryResult = { data: unknown; error: unknown; count: number | null };

// Chainable Supabase-shaped stub: every filter/terminal returns the same
// thenable object, so a `.maybeSingle()` chain and an `.order()` chain both
// resolve to the table's canned result. Mirrors the supervisor-page harness.
function makeQuery(result: QueryResult): Record<string, unknown> {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const m of ["select", "eq", "order", "update", "maybeSingle"]) {
    q[m] = self;
  }
  q.then = (resolve: (v: QueryResult) => unknown) => resolve(result);
  return q;
}

function makeClient(resultFor: (table: string) => QueryResult) {
  return { from: (table: string) => makeQuery(resultFor(table)) };
}

const QUOTE_OPTION = {
  id: "opt-1",
  option_index: 0,
  customer_selected: true,
  cruise_line: "Norwegian",
  ship_name: "Bliss",
  sailing_date: "2026-09-15",
  duration_nights: 7,
  cabin_category: "Balcony",
  passenger_count: 2,
  commissionable_fare_cents: 100000,
  non_commissionable_total_cents: 20000,
  total_amount_cents: 120000,
  currency: "USD",
  is_recommended: true,
};

function quoteRow(displayName: string | null) {
  return {
    id: QUOTE_ID,
    tenant_id: TENANT_ID,
    status: "viewed", // not "sent" → skips the sent→viewed CAS update
    locked_price_cents: 120000,
    estimate_price_cents: null,
    custom_notes: null,
    customer_facing_intro: null,
    recommendation_rationale: null,
    show_recommendation: false,
    show_breakdown_to_customer: false,
    valid_until: null,
    tenants: { display_name: displayName, support_email: "help@coralcove.example" },
  };
}

// hostValue: the raw platform_settings.value; null → row absent.
function clientFor(displayName: string | null, hostValue: unknown) {
  return makeClient((table): QueryResult => {
    if (table === "quotes") return { data: quoteRow(displayName), error: null, count: null };
    if (table === "quote_options") return { data: [QUOTE_OPTION], error: null, count: null };
    // platform_settings
    return { data: hostValue === null ? null : { value: hostValue }, error: null, count: null };
  });
}

async function renderPage(): Promise<string> {
  return renderToStaticMarkup(
    await CustomerQuoteViewPage({ params: Promise.resolve({ token: "tok-abc" }) }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeAuditLog.mockResolvedValue(undefined);
  mocks.headers.mockResolvedValue({ get: () => null });
});

describe("q/[token] quote view — §20.7 tenant-of-record disclosure (#1876)", () => {
  it("renders the real sub-host + host-agency legal name (never a placeholder)", async () => {
    mocks.createServiceRoleClient.mockReturnValue(
      clientFor("Coral Cove Travel", "Wavecrest Travel LLC"),
    );
    const html = await renderPage();
    expect(html).toContain("This booking will be made through");
    expect(html).toContain("Wavecrest Travel LLC");
    expect(html).toContain("Coral Cove Travel");
    // No fabricated placeholder legal names.
    expect(html).not.toContain("Sub-host");
    expect(html).not.toContain("Host Agency");
  });

  it("fails closed — missing host-agency legal name renders NO disclosure and no placeholder", async () => {
    mocks.createServiceRoleClient.mockReturnValue(clientFor("Coral Cove Travel", null));
    const html = await renderPage();
    expect(html).not.toContain("This booking will be made through");
    expect(html).not.toContain("Sub-host");
    expect(html).not.toContain("Host Agency");
    // Rest of the page still renders (non-vacuous).
    expect(html).toContain("Norwegian");
  });

  it("fails closed — missing tenant display_name renders NO disclosure and no placeholder", async () => {
    mocks.createServiceRoleClient.mockReturnValue(clientFor(null, "Wavecrest Travel LLC"));
    const html = await renderPage();
    expect(html).not.toContain("This booking will be made through");
    expect(html).not.toContain("Wavecrest Travel LLC");
    expect(html).not.toContain("Sub-host");
    expect(html).not.toContain("Host Agency");
    expect(html).toContain("Norwegian");
  });
});
