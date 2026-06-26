// email_customer tool handler.
//
// Pinned contracts:
//   1. Anonymous turn (no customer_email) → sent:false, not_signed_in, NOT mutating,
//      and sendEmail is NEVER called.
//   2. SECURITY: the recipient is dispatchCtx.customer_email — NOT any address the
//      model puts in the tool input. A sneaky input.to / input.recipient is ignored.
//   3. from-address/name derive from persona_slug ("marcus-cole" → Marcus Cole
//      <marcus@ai-travelconcierge.com>) via platform_resend.
//   4. Missing subject/body → sent:false, NOT mutating, sendEmail not called.
//   5. sendEmail failure → sent:false, NOT mutating.
//   6. tenant load DB error → throws (surfaces as tool_handler_failed).

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolDispatchContext } from "@/lib/personas/tools/dispatch";
import type { TenantContext } from "@/lib/db/tenant-context";

const TENANT_ID = "11111111-2222-3333-4444-555555555555";

const mocks = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mocks.sendEmail }));

function makeDb(
  tenantResult: { data: unknown; error: null | { message: string } },
  brandingResult: { data: unknown; error: null } = { data: null, error: null },
): ToolDispatchContext["db"] {
  return {
    from: (table: string) => {
      const result =
        table === "tenants" ? tenantResult : table === "tenant_branding" ? brandingResult : { data: null, error: null };
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = () => Promise.resolve(result);
      return chain;
    },
  } as unknown as ToolDispatchContext["db"];
}

const TENANT_ROW = {
  id: TENANT_ID,
  legal_name: "Booking by AI Travel Concierge",
  mailing_address: "1 Test St",
  support_email: "support@ai-travelconcierge.com",
};

function makeCtx(over: Partial<ToolDispatchContext> = {}): ToolDispatchContext {
  const ctx: TenantContext = { tenant_id: TENANT_ID, source: { kind: "http_request", user_id: "u1" } };
  return {
    ctx,
    db: makeDb({ data: TENANT_ROW, error: null }),
    conversation_id: "cccccccc-dddd-eeee-ffff-000000000000",
    contact_id: null,
    customer_email: "jane@example.com",
    persona_slug: "marcus-cole",
    ...over,
  };
}

let handler: typeof import("@/lib/personas/tools/handlers/email-customer").emailCustomer;
let personaFromIdentity: typeof import("@/lib/personas/tools/handlers/email-customer").personaFromIdentity;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.sendEmail.mockResolvedValue({ status: "sent" });
  ({ emailCustomer: handler, personaFromIdentity } = await import(
    "@/lib/personas/tools/handlers/email-customer"
  ));
});

describe("personaFromIdentity", () => {
  it("derives marcus@email.ai-travelconcierge.com / Marcus Cole from 'marcus-cole'", () => {
    expect(personaFromIdentity("marcus-cole")).toEqual({
      fromAddress: "marcus@email.ai-travelconcierge.com",
      fromName: "Marcus Cole",
    });
  });
  it("handles a single-segment slug", () => {
    expect(personaFromIdentity("sofia")).toEqual({
      fromAddress: "sofia@email.ai-travelconcierge.com",
      fromName: "Sofia",
    });
  });
  it("falls back to concierge for empty/nullish slug", () => {
    expect(personaFromIdentity(null)).toEqual({
      fromAddress: "concierge@email.ai-travelconcierge.com",
      fromName: "AI Travel Concierge",
    });
  });
});

describe("email_customer handler", () => {
  const goodInput = { subject: "Norwegian Bliss deck plans", body_markdown: "Here you go: https://x.com/deck17" };

  it("does NOT send for an anonymous turn (no customer_email)", async () => {
    const res = await handler(goodInput, makeCtx({ customer_email: null }));
    const parsed = JSON.parse(res.content);
    expect(parsed.sent).toBe(false);
    expect(parsed.reason).toBe("not_signed_in");
    expect(res.was_mutating).toBe(false);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("sends to the SIGNED-IN account email, ignoring any recipient in the model input", async () => {
    const sneaky = { ...goodInput, to: "attacker@evil.com", recipient: "victim@elsewhere.com" };
    const res = await handler(sneaky, makeCtx());
    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    const arg = mocks.sendEmail.mock.calls[0]?.[0];
    expect(arg.to).toBe("jane@example.com"); // the account email, NOT the input's addresses
    expect(arg.to).not.toBe("attacker@evil.com");
    expect(arg.tenant.email_from_address).toBe("marcus@email.ai-travelconcierge.com");
    expect(arg.tenant.email_from_name).toBe("Marcus Cole");
    expect(arg.tenant.email_send_pattern).toBe("platform_resend");
    expect(arg.category).toBe("concierge"); // rate-limited, not unbounded transactional
    expect(arg.subject).toBe("Norwegian Bliss deck plans");
    expect(arg.html).toContain("https://x.com/deck17");
    expect(arg.reply_to).toBe("support@ai-travelconcierge.com");
    expect(JSON.parse(res.content).sent).toBe(true);
    expect(res.was_mutating).toBe(true);
  });

  it("returns not-sent for missing subject or body, without calling sendEmail", async () => {
    const res = await handler({ subject: "", body_markdown: "x" }, makeCtx());
    expect(JSON.parse(res.content).sent).toBe(false);
    expect(JSON.parse(res.content).reason).toBe("missing_subject_or_body");
    expect(res.was_mutating).toBe(false);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("reports a send failure as sent:false, not mutating", async () => {
    mocks.sendEmail.mockResolvedValue({ status: "failed", reason: "platform_resend_key_not_set" });
    const res = await handler(goodInput, makeCtx());
    const parsed = JSON.parse(res.content);
    expect(parsed.sent).toBe(false);
    expect(parsed.reason).toBe("platform_resend_key_not_set");
    expect(res.was_mutating).toBe(false);
  });

  it("throws when the tenant load errors (surfaces as tool_handler_failed)", async () => {
    const ctx = makeCtx({ db: makeDb({ data: null, error: { message: "connection reset" } }) });
    await expect(handler(goodInput, ctx)).rejects.toThrow(/tenant load failed/);
  });
});
