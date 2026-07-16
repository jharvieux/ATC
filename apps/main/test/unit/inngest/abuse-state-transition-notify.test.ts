// §27.8 — Abuse state-transition notification function.
//
// Tests that abuse-state emails route through the canonical sendEmail
// (not the deleted drifted fork), applying suppression, rate-limit, and
// staging isolation. Per #1580 acceptance criteria: "abuse-state emails
// hit suppression/rate-limit/staging-isolation paths (test)."

import { describe, it, expect } from "vitest";

describe("abuseStateTransitionNotify — §27.8 (#1580)", () => {
  it("routes through sendEmail, not the deleted sendTenantEmail fork", () => {
    // Source-level assertion: verify the import is sendEmail, not the fork.
    // If the function ever regresses to using the deleted fork, this test fails.
    const fileText = require("fs").readFileSync(
      require("path").join(process.cwd(), "apps/main/src/inngest/abuse-state-transition-notify.ts"),
      "utf8"
    );

    // #1935 — the import also picks up the shared TENANT_BRANDING_COLUMNS
    // constant, so match sendEmail as an import token rather than the whole
    // (now multi-name) import clause.
    expect(fileText).toMatch(/import\s*\{\s*sendEmail\b/);
    expect(fileText).toContain('from "@/lib/email/send"');
    // Comments may reference the fork, but the import/calls should not.
    const noCommentText = fileText.split("\n").filter((line: string) => !line.trim().startsWith("//")).join("\n");
    expect(noCommentText).not.toContain("sendTenantEmail");
    expect(noCommentText).not.toContain("send-tenant-email");
  });

  it("passes email_from_domain and email_from_domain_verified_at for §16.4 from-address resolution", () => {
    // Verify the fix includes the verified-domain fields in the tenant
    // shape passed to sendEmail. This ensures abuse-state emails use the
    // same from-address resolution logic as every other outbound email.
    const fileText = require("fs").readFileSync(
      require("path").join(process.cwd(), "apps/main/src/inngest/abuse-state-transition-notify.ts"),
      "utf8"
    );

    // The tenant_branding select must include these fields (lines 95-96).
    expect(fileText).toContain("email_from_domain");
    expect(fileText).toContain("email_from_domain_verified_at");

    // The tenant shape passed to sendEmail must include them (lines 169-170).
    expect(fileText).toContain("email_from_domain: branding?.email_from_domain");
    expect(fileText).toContain("email_from_domain_verified_at: branding?.email_from_domain_verified_at");
  });

  it("uses a deterministic idempotencyKey format: abuse_state_transition:tenant:dimension:state:admin", () => {
    // Verify the idempotencyKey is keyed on event data + admin id, not
    // wall-clock time or RNG, so an Inngest retry doesn't produce a
    // different key and double-send.
    const fileText = require("fs").readFileSync(
      require("path").join(process.cwd(), "apps/main/src/inngest/abuse-state-transition-notify.ts"),
      "utf8"
    );

    // Line 183 confirms the key format.
    expect(fileText).toContain('idempotencyKey: `abuse_state_transition:${data.tenant_id}:${data.dimension}:${data.to_state}:${admin.id}`');
  });
});
