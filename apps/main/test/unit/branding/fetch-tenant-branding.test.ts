// Lock down the input + DB-branch behavior so a regression can't silently
// degrade tenant landing pages to the platform hero (or 500 on a bad
// fetch). Covers the two null-fast inputs PLUS the four DB outcomes
// (active+branding, inactive, active+no-branding, DB error) — issue #655.

import { describe, it, expect, vi, afterEach } from "vitest";

// Stub the service-role client. Each test installs its own
// `.from().select().eq().maybeSingle()` chain via `mockMaybeSingle`.
const mockMaybeSingle = vi.fn();
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: mockMaybeSingle,
        }),
      }),
    }),
  }),
}));

import { fetchTenantBranding } from "@/lib/branding/fetch-tenant-branding";

afterEach(() => {
  mockMaybeSingle.mockReset();
});

describe("fetchTenantBranding — null-fast inputs", () => {
  it("returns null for a null tenant id (anonymous / unresolved)", async () => {
    // Why: an absent x-resolved-tenant-id header means we couldn't
    // figure out who the caller is talking to. Defaulting to the
    // platform hero is the safe fallback.
    const result = await fetchTenantBranding(null);
    expect(result).toBeNull();
    // Must short-circuit BEFORE the service-role query — otherwise every
    // anonymous platform-domain request burns a needless DB call.
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });

  it("returns null for the 'platform' sentinel (set by proxy.ts on the platform domain)", async () => {
    // Why: proxy.ts emits the literal string "platform" when no tenant
    // subdomain resolved. If this branch ever stopped firing, every
    // platform-domain request would do an extra service-role query +
    // return no rows, masquerading as a perf bug.
    const result = await fetchTenantBranding("platform");
    expect(result).toBeNull();
    expect(mockMaybeSingle).not.toHaveBeenCalled();
  });
});

describe("fetchTenantBranding — DB branches (issue #655)", () => {
  it("returns populated branding for an active tenant with a branding row", async () => {
    // Why: the happy path — every public landing on a tenant subdomain
    // depends on this returning the flattened TenantBranding shape (not
    // the Supabase nested-array shape). If the flattening regresses, the
    // landing renders display_name="undefined" instead of the brand.
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        display_name: "Acme Travel",
        status: "active",
        tenant_branding: [
          {
            logo_url: "https://acme.example.com/logo.svg",
            logo_dark_url: "https://acme.example.com/logo-dark.svg",
            favicon_url: "https://acme.example.com/favicon.ico",
            slogan: "Plan smarter, travel further.",
            primary_color: "#2563eb",
            secondary_color: "#6b7280",
            accent_color: "#f59e0b",
            font_family: "Inter, sans-serif",
          },
        ],
      },
      error: null,
    });

    const result = await fetchTenantBranding("tenant-acme");
    expect(result).toEqual({
      display_name: "Acme Travel",
      logo_url: "https://acme.example.com/logo.svg",
      logo_dark_url: "https://acme.example.com/logo-dark.svg",
      favicon_url: "https://acme.example.com/favicon.ico",
      slogan: "Plan smarter, travel further.",
      primary_color: "#2563eb",
      secondary_color: "#6b7280",
      accent_color: "#f59e0b",
      font_family: "Inter, sans-serif",
    });
  });

  it("returns null for an inactive tenant (no leaked branding for suspended/terminated tenants)", async () => {
    // Why: a tenant whose status is anything other than 'active'
    // (suspended, terminated, pending_review) must NOT have their
    // branding rendered on the public landing — the platform hero is
    // the right fallback, and we don't want to keep marketing a tenant
    // we've kicked off.
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        display_name: "Suspended Co",
        status: "suspended",
        tenant_branding: [
          { logo_url: "https://x.example.com/l.svg", logo_dark_url: null, slogan: "Hi" },
        ],
      },
      error: null,
    });

    const result = await fetchTenantBranding("tenant-suspended");
    expect(result).toBeNull();
  });

  it("returns display_name with nulls when an active tenant has no branding row", async () => {
    // Why: the tenants→tenant_branding join is left-style; an active
    // tenant that hasn't customized their branding gets an empty array.
    // We still surface display_name so the landing can say "Welcome to
    // Acme" even without a logo. Defaulting to null for the visual
    // fields keeps the renderer's existing fallback paths working.
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        display_name: "No-Brand Co",
        status: "active",
        tenant_branding: [],
      },
      error: null,
    });

    const result = await fetchTenantBranding("tenant-no-branding");
    expect(result).toEqual({
      display_name: "No-Brand Co",
      logo_url: null,
      logo_dark_url: null,
      favicon_url: null,
      slogan: null,
      primary_color: null,
      secondary_color: null,
      accent_color: null,
      font_family: null,
    });
  });

  it("returns display_name with nulls when PostgREST returns null for tenant_branding (1-to-1 FK, no row)", async () => {
    // Why: the production crash on lisa-travel — PostgREST detected a unique
    // constraint on the tenant_id FK column and returned null (not []) when
    // there is no branding row. The old code did `row.tenant_branding[0]`,
    // which threw `TypeError: Cannot read properties of null (reading '0')`.
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        display_name: "Lisa Travel",
        status: "active",
        tenant_branding: null,
      },
      error: null,
    });

    const result = await fetchTenantBranding("lisa-travel");
    expect(result).toEqual({
      display_name: "Lisa Travel",
      logo_url: null,
      logo_dark_url: null,
      favicon_url: null,
      slogan: null,
      primary_color: null,
      secondary_color: null,
      accent_color: null,
      font_family: null,
    });
  });

  it("returns branding when PostgREST returns a plain object for tenant_branding (1-to-1 FK, row present)", async () => {
    // Why: when PostgREST detects a 1-to-1 constraint AND the row exists, it
    // returns the embed as a plain object, not an array. Without the
    // Array.isArray guard, `Array.isArray(obj)` is false and the old code
    // would fall through (pre-fix: this path was unhandled; post-fix: it
    // goes to the `tb ?? null` branch, returning the object directly).
    mockMaybeSingle.mockResolvedValueOnce({
      data: {
        display_name: "Object Travel",
        status: "active",
        tenant_branding: {
          logo_url: "https://obj.example.com/logo.svg",
          logo_dark_url: null,
          favicon_url: null,
          slogan: "Just a test",
          primary_color: "#111111",
          secondary_color: null,
          accent_color: null,
          font_family: null,
        },
      },
      error: null,
    });

    const result = await fetchTenantBranding("object-travel");
    expect(result).toMatchObject({
      display_name: "Object Travel",
      logo_url: "https://obj.example.com/logo.svg",
      slogan: "Just a test",
      primary_color: "#111111",
    });
  });

  it("throws on a DB/network error so the landing 500s instead of silently degrading", async () => {
    // Why: a real DB failure (connection refused, PostgREST 500, RLS
    // misconfig) should be loud, not silently rendered as the platform
    // hero. A 500 surfaces in observability; a silent fallback would
    // mask a real outage from the tenant whose page is broken.
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "connection refused", code: "08006", details: null, hint: null },
    });

    await expect(fetchTenantBranding("tenant-x")).rejects.toThrow(
      /fetchTenantBranding: connection refused/,
    );
  });
});
