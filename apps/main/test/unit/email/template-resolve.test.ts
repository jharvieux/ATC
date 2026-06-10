// #963 — resolveEmailContent: tenant override → platform default, fail loud.
//
// Intent under test (issue acceptance criteria):
//   1. With no override row, the registry default subject is used and the
//      body stays the platform default (overrideBodyText null).
//   2. With an override row, the tenant's subject/body are rendered with
//      the sender's variables.
//   3. A failed override READ throws — we never silently send the platform
//      default when the tenant may have customized the email.
//   4. The layout wrapper keeps the CAN-SPAM footer and escapes the body.

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailContent, renderOverrideBodyInLayout } from "@/lib/email/template-resolve";

function makeDb(result: { data: unknown; error: { message: string } | null }): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => result,
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

const PRE_CRUISE_VARS = {
  customer_name: "Alice",
  ship_name: "Wonder of the Seas",
  cruise_line: "Royal Caribbean",
  sailing_date: "2026-09-12",
  companion_page_url: "https://x.example/companion/t",
};

describe("resolveEmailContent", () => {
  it("uses the registry default subject and platform body when no override exists", async () => {
    const resolved = await resolveEmailContent({
      db: makeDb({ data: null, error: null }),
      tenant_id: "t-1",
      email_type: "pre_cruise_t_90",
      variables: PRE_CRUISE_VARS,
    });
    expect(resolved.subject).toBe("90 days to your Royal Caribbean cruise — let the anticipation begin!");
    expect(resolved.overrideBodyText).toBeNull();
  });

  it("renders the tenant's subject and body override with the sender's variables", async () => {
    const resolved = await resolveEmailContent({
      db: makeDb({
        data: {
          subject_template: "{{customer_name}}, {{ship_name}} awaits!",
          body_template: "Hi {{customer_name}},\n\nYour cruise sails {{sailing_date}}.",
        },
        error: null,
      }),
      tenant_id: "t-1",
      email_type: "pre_cruise_t_90",
      variables: PRE_CRUISE_VARS,
    });
    expect(resolved.subject).toBe("Alice, Wonder of the Seas awaits!");
    expect(resolved.overrideBodyText).toBe("Hi Alice,\n\nYour cruise sails 2026-09-12.");
  });

  it("supports subject-only overrides (body stays platform default)", async () => {
    const resolved = await resolveEmailContent({
      db: makeDb({ data: { subject_template: "Custom: {{ship_name}}", body_template: null }, error: null }),
      tenant_id: "t-1",
      email_type: "pre_cruise_t_90",
      variables: PRE_CRUISE_VARS,
    });
    expect(resolved.subject).toBe("Custom: Wonder of the Seas");
    expect(resolved.overrideBodyText).toBeNull();
  });

  it("throws when the override read fails — never a silent default fallback", async () => {
    await expect(
      resolveEmailContent({
        db: makeDb({ data: null, error: { message: "connection refused" } }),
        tenant_id: "t-1",
        email_type: "pre_cruise_t_90",
        variables: PRE_CRUISE_VARS,
      }),
    ).rejects.toThrow(/tenant_email_templates read failed/);
  });

  it("throws when an override references a variable the sender did not supply", async () => {
    await expect(
      resolveEmailContent({
        db: makeDb({ data: { subject_template: "Hi {{not_a_variable}}", body_template: null }, error: null }),
        tenant_id: "t-1",
        email_type: "pre_cruise_t_90",
        variables: PRE_CRUISE_VARS,
      }),
    ).rejects.toThrow(/not_a_variable/);
  });
});

describe("renderOverrideBodyInLayout", () => {
  const layout = {
    branding: {},
    tenant_legal_name: "Test Agency LLC",
    tenant_business_address: "123 Main St, Miami FL",
    unsubscribe_url: "https://x.example/unsub?token=abc",
  };

  it("keeps the CAN-SPAM footer (legal name, address, unsubscribe) around the override body", async () => {
    const html = await renderOverrideBodyInLayout(layout, "Hello Alice,\n\nSee you aboard!");
    expect(html).toContain("Hello Alice,");
    expect(html).toContain("See you aboard!");
    expect(html).toContain("Test Agency LLC");
    expect(html).toContain("123 Main St, Miami FL");
    expect(html).toContain("https://x.example/unsub?token=abc");
  });

  it("escapes markup in the override body", async () => {
    const html = await renderOverrideBodyInLayout(layout, "<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
