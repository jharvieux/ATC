// #1740 — compliance-nightly's tenants SELECT must not reference branding columns.
//
// The bug: the tenants SELECT carried email_send_pattern,
// tenant_resend_api_key_encrypted, email_from_address and email_from_name.
// Those columns live on tenant_branding, never on tenants, so postgres
// rejected the ENTIRE query with `column tenants.email_send_pattern does not
// exist`. The cron then hit its `if (tenantErr) return` guard and exited before
// any nudge was recorded or sent — silently, every night at 04:00 UTC, with the
// failure visible only in the postgres logs.
//
// These tests pin the corrected data-access shape: the phantom columns can't
// creep back into the tenants SELECT, and the send path must source its email
// config from the branding row.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  selectArgs: [] as Array<{ table: string; arg: string }>,
  sendEmailArgs: [] as Array<Record<string, unknown>>,
  // Per-table read failure injection — drives the fail-loud tests below.
  readErrors: {} as Record<string, { message: string } | undefined>,
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => {
    const builder = (table: string) => {
      const chain: Record<string, unknown> = {};
      const result = (data: unknown) => {
        const err = mocks.readErrors[table];
        return err
          ? Promise.resolve({ data: null, error: err })
          : Promise.resolve({ data, error: null });
      };

      chain["select"] = (arg: string) => {
        mocks.selectArgs.push({ table, arg });
        if (table === "tenants") {
          // #1933 — the real query now paginates via .order().range(); a
          // second .eq() (the ICA-drift path) must also stay chainable, but
          // that path never reaches here in this suite (empty legal_documents
          // short-circuits it first).
          const tenantsChain: Record<string, unknown> = {
            eq: () => tenantsChain,
            order: () => ({ range: () => result([{
              id: "t1",
              status: "active",
              support_email: "owner@tenant.com",
              legal_name: "Anchor & Compass",
              display_name: "Anchor",
              mailing_address: null,
              subscription_status: "active",
              non_paying_since: null,
              is_platform_internal: false,
            }]) }),
          };
          return tenantsChain;
        }
        if (table === "tenant_branding") {
          // #1933/#1935 — real query now paginates via .order().range().
          return {
            in: () => ({
              order: () => ({ range: () => result([{
                tenant_id: "t1",
                email_send_pattern: "tenant_resend",
                tenant_resend_api_key_encrypted: "enc-key",
                email_from_address: "concierge@tenant.com",
                email_from_name: "Tenant Concierge",
                email_from_domain: null,
                email_from_domain_verified_at: null,
              }]) }),
            }),
          };
        }
        if (table === "conversations" || table === "bookings") {
          // 95 days idle → trips 90d, the most severe level that still emails
          // (180d is breadcrumb-only by design).
          const old = new Date(Date.now() - 95 * 24 * 60 * 60 * 1000).toISOString();
          return {
            eq: () => ({ order: () => ({ limit: () => result([{ created_at: old }]) }) }),
          };
        }
        if (table === "tenant_inactivity_nudges") {
          // No prior nudge at this level → not already_sent.
          return { eq: () => ({ eq: () => ({ maybeSingle: () => result(null) }) }) };
        }
        if (table === "legal_documents") {
          // No published ICA → the version-drift check is a no-op here.
          return {
            eq: () => ({ is: () => ({ order: () => ({ limit: () => result([]) }) }) }),
          };
        }
        return { eq: () => result([]) };
      };
      chain["insert"] = () => result(null);
      chain["update"] = () => ({ eq: () => result(null) });
      return chain;
    };
    return { from: builder };
  },
}));

vi.mock("@/lib/email/send", () => ({
  sendEmail: (args: Record<string, unknown>) => {
    mocks.sendEmailArgs.push(args);
    return Promise.resolve({ status: "sent" });
  },
  TENANT_BRANDING_COLUMNS: "tenant_id, email_send_pattern, tenant_resend_api_key_encrypted, email_from_address, email_from_name, email_from_domain, email_from_domain_verified_at",
}));

import { complianceNightly } from "@/inngest/compliance-nightly";

// The Inngest wrapper exposes the handler as `fn`; call it directly.
const runCron = () =>
  (complianceNightly as unknown as { fn: () => Promise<unknown> }).fn();

describe("compliance-nightly — #1740 tenants/tenant_branding column split", () => {
  beforeEach(() => {
    mocks.selectArgs.length = 0;
    mocks.sendEmailArgs.length = 0;
    for (const k of Object.keys(mocks.readErrors)) delete mocks.readErrors[k];
  });

  it("never selects branding-only columns from tenants (the column-does-not-exist bug)", async () => {
    await runCron();

    const tenantsSelect = mocks.selectArgs.find((s) => s.table === "tenants" && s.arg.includes("support_email"));
    expect(tenantsSelect).toBeDefined();
    // Each of these on `tenants` fails the WHOLE query in postgres, which
    // silently disables every nudge — the exact production symptom.
    for (const col of [
      "email_send_pattern",
      "tenant_resend_api_key_encrypted",
      "email_from_address",
      "email_from_name",
    ]) {
      expect(tenantsSelect!.arg).not.toContain(col);
    }
  });

  it("reads the email send config from tenant_branding instead", async () => {
    await runCron();

    const brandingSelect = mocks.selectArgs.find((s) => s.table === "tenant_branding");
    expect(brandingSelect).toBeDefined();
    expect(brandingSelect!.arg).toContain("email_send_pattern");
    expect(brandingSelect!.arg).toContain("email_from_address");
  });

  it("threads the branding row through to the reminder send (not a platform_resend fallback)", async () => {
    await runCron();

    expect(mocks.sendEmailArgs).toHaveLength(1);
    const tenantArg = mocks.sendEmailArgs[0]!["tenant"] as Record<string, unknown>;
    // If branding were dropped on the floor, these would silently fall back to
    // platform_resend and the tenant's own domain would stop being used.
    expect(tenantArg["email_send_pattern"]).toBe("tenant_resend");
    expect(tenantArg["email_from_address"]).toBe("concierge@tenant.com");
    expect(tenantArg["tenant_resend_api_key_encrypted"]).toBe("enc-key");
  });
});

// #1740 root cause was not the wrong column — it was that the wrong column was
// UNOBSERVABLE. A read error that `return`s makes the Inngest run report
// success: no retry, no failed-run alert, and nudges silently stop. These tests
// fail if either guard regresses to a bare return, because a bare return
// resolves instead of rejecting.
describe("compliance-nightly — read failures fail loud", () => {
  beforeEach(() => {
    mocks.selectArgs.length = 0;
    mocks.sendEmailArgs.length = 0;
    for (const k of Object.keys(mocks.readErrors)) delete mocks.readErrors[k];
  });

  it("throws when the tenants read fails, so Inngest retries instead of reporting success", async () => {
    mocks.readErrors["tenants"] = { message: 'column tenants.bogus does not exist' };

    await expect(runCron()).rejects.toThrow(/tenants\.select failed/);
  });

  it("throws when the tenant_branding read fails rather than sending with wrong email config", async () => {
    mocks.readErrors["tenant_branding"] = { message: 'column tenant_branding.bogus does not exist' };

    await expect(runCron()).rejects.toThrow(/tenant_branding\.select failed/);
    // Proceeding past this guard would send every reminder through
    // platform_resend with the tenant's own domain dropped.
    expect(mocks.sendEmailArgs).toHaveLength(0);
  });
});
