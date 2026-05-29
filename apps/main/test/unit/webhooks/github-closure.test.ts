// BP32 §32.10.7 — GitHub issues.closed webhook signature verification.
//
// Tests cover the signature check in isolation. The full route handler
// (DB lookup + update + audit + Inngest emit) requires the platform-admin
// audit wrapper which needs a DB connection; that's covered by manual
// smoke + the cross-tenant probe in BP30 indirectly.

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyGitHubSignature } from "@/lib/webhooks/github-signature";

describe("GitHub webhook signature verification", () => {
  const SECRET = "test-webhook-secret-do-not-use-in-prod";
  const PAYLOAD = JSON.stringify({ action: "closed", issue: { number: 42 } });

  it("accepts a correctly signed payload", () => {
    const sig = "sha256=" + createHmac("sha256", SECRET).update(PAYLOAD).digest("hex");
    expect(verifyGitHubSignature(PAYLOAD, sig, SECRET)).toBe(true);
  });

  it("rejects a payload signed with the wrong secret", () => {
    const sig = "sha256=" + createHmac("sha256", "wrong-secret").update(PAYLOAD).digest("hex");
    expect(verifyGitHubSignature(PAYLOAD, sig, SECRET)).toBe(false);
  });

  it("rejects an altered payload", () => {
    const sig = "sha256=" + createHmac("sha256", SECRET).update(PAYLOAD).digest("hex");
    const altered = PAYLOAD.replace("42", "43");
    expect(verifyGitHubSignature(altered, sig, SECRET)).toBe(false);
  });

  it("rejects missing signature header", () => {
    expect(verifyGitHubSignature(PAYLOAD, null, SECRET)).toBe(false);
  });

  it("rejects signature without 'sha256=' prefix", () => {
    const sig = createHmac("sha256", SECRET).update(PAYLOAD).digest("hex");
    expect(verifyGitHubSignature(PAYLOAD, sig, SECRET)).toBe(false);
  });

  it("rejects empty signature header", () => {
    expect(verifyGitHubSignature(PAYLOAD, "", SECRET)).toBe(false);
  });
});
