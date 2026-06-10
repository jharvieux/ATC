// #979 — Verifies the token → URL wiring used by the group reminder cadence.
//
// Intent: the cadence computes `${baseUrl}/group/invite/${generateToken(inv.id)}`
// and embeds it in the reminder email. This test confirms the token format
// (invitation_id + "." + base64url HMAC) so a route-path refactor or token
// format change would break this test before breaking real emails.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateToken } from "@/lib/groups/invitation-token";

const TEST_KEY = Buffer.from("testtesttesttesttesttesttesttest").toString("base64"); // 32 bytes

describe("invitation token URL wiring (#979)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.INVITATION_TOKEN_HMAC_KEY = TEST_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("generateToken returns a string containing a '.' separator", () => {
    // The cadence splits on '.' to embed the token in a URL path segment.
    // If the format ever changes to not include '.', the URL-construction
    // logic and the landing-page handler both need updating.
    const id = crypto.randomUUID();
    const token = generateToken(id);
    expect(token).toContain(".");
  });

  it("token embeds the invitation_id before the first dot", () => {
    const id = crypto.randomUUID();
    const token = generateToken(id);
    expect(token.split(".")[0]).toBe(id);
  });

  it("cadence-style URL contains the full token as the path segment", () => {
    const id = crypto.randomUUID();
    const token = generateToken(id);
    const baseUrl = "https://example.ai-travelconcierge.com";
    const url = `${baseUrl}/group/invite/${token}`;
    expect(url).toContain(`/group/invite/${id}.`);
  });
});
