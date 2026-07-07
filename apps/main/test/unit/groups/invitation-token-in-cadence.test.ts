// #979 / #1604 — Verifies the token → URL wiring used by the group reminder
// cadence.
//
// Intent: the cadence computes `${baseUrl}/group/invite/${await generateToken(inv.id)}`
// and embeds it in the reminder email. This test confirms the token is a
// single URL-safe path segment that a route handler can extract and verify
// back to the same invitation_id — format-agnostic, so a future re-encoding
// of the token itself doesn't require touching this test.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateToken, parseAndVerifyHmac } from "@/lib/groups/invitation-token";

const TEST_KEY = Buffer.from("testtesttesttesttesttesttesttest").toString("base64"); // 32 bytes

describe("invitation token URL wiring (#979)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.INVITATION_TOKEN_HMAC_KEY = TEST_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("generateToken produces a URL-safe path segment (no slashes)", async () => {
    const id = crypto.randomUUID();
    const token = await generateToken(id);
    expect(token).not.toContain("/");
  });

  it("cadence-style URL round-trips back to the invitation_id", async () => {
    const id = crypto.randomUUID();
    const token = await generateToken(id);
    const baseUrl = "https://example.ai-travelconcierge.com";
    const url = `${baseUrl}/group/invite/${token}`;
    const extracted = url.split("/group/invite/")[1]!;

    const { invitation_id, ok } = await parseAndVerifyHmac(extracted);
    expect(ok).toBe(true);
    expect(invitation_id).toBe(id);
  });
});
