// §17.2 — Microsoft email recovery chain unit tests.
//
// Contracts pinned here:
//   1. OAuth email claim wins when present and email-shaped.
//   2. Graph `mail` field wins when oauth email is absent.
//   3. userPrincipalName is used when mail is absent AND it is email-shaped
//      (personal MSA login address like user@outlook.com).
//   4. Non-email-shaped UPN (phone-only MSA signup) is skipped; chain
//      continues to otherMails.
//   5. otherMails[0] is the final fallback before null.
//   6. Null is returned when all sources are exhausted → caller redirects
//      to /signup/email-prompt.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { recoverMicrosoftEmail } from "@/lib/auth/microsoft-email-recovery";

const TOKEN = "ms-graph-token";

function mockFetch(responses: Record<string, object>) {
  return vi.fn((url: string) => {
    const key = Object.keys(responses).find((k) => url.includes(k));
    const body = key ? responses[key] : {};
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body),
    });
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("recoverMicrosoftEmail", () => {
  it("returns the oauth email immediately when it is email-shaped", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    const result = await recoverMicrosoftEmail("alice@example.com", TOKEN);
    expect(result).toBe("alice@example.com");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls through to Graph when oauth email is null", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ "$select=mail,userPrincipalName": { mail: "alice@outlook.com", userPrincipalName: "alice@outlook.com" } }),
    );
    expect(await recoverMicrosoftEmail(null, TOKEN)).toBe("alice@outlook.com");
  });

  it("uses userPrincipalName when mail is null but UPN is email-shaped (personal MSA)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ "$select=mail,userPrincipalName": { mail: null, userPrincipalName: "alice@outlook.com" } }),
    );
    expect(await recoverMicrosoftEmail(null, TOKEN)).toBe("alice@outlook.com");
  });

  it("skips a non-email-shaped UPN and falls to otherMails", async () => {
    // Phone-only MSA signup: UPN is an internal identifier, not an email address.
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "$select=mail,userPrincipalName": { mail: null, userPrincipalName: "user_abc123" },
        "$select=otherMails": { otherMails: ["alice@gmail.com"] },
      }),
    );
    expect(await recoverMicrosoftEmail(null, TOKEN)).toBe("alice@gmail.com");
  });

  it("returns otherMails[0] when mail and UPN are both absent", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "$select=mail,userPrincipalName": { mail: null, userPrincipalName: null },
        "$select=otherMails": { otherMails: ["proxy@contoso.com"] },
      }),
    );
    expect(await recoverMicrosoftEmail(null, TOKEN)).toBe("proxy@contoso.com");
  });

  it("returns null when all sources are exhausted", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "$select=mail,userPrincipalName": { mail: null, userPrincipalName: null },
        "$select=otherMails": { otherMails: [] },
      }),
    );
    expect(await recoverMicrosoftEmail(null, TOKEN)).toBeNull();
  });

  it("returns null when Graph calls fail (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network error"))));
    expect(await recoverMicrosoftEmail(null, TOKEN)).toBeNull();
  });
});
