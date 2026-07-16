// §26.3 — readAuthTimeFromClaims must extract the authentication timestamp
// from a signature-verified claims payload. GoTrue does not emit auth_time;
// the equivalent is amr[].timestamp. The sensitive-route session-age check
// depends on this: if it returns null, every sensitive route denies
// unconditionally. #1939 — the input is the verified `claims` object, not a
// raw JWT string, so no unverified re-decode happens on the re-auth path.

import { describe, it, expect } from "vitest";
import { readAuthTimeFromClaims } from "@/lib/auth/assert-permission";

const NOW_S = Math.floor(Date.now() / 1000);

describe("readAuthTimeFromClaims", () => {
  it("returns auth_time when present (custom hook compatibility)", () => {
    expect(readAuthTimeFromClaims({ auth_time: NOW_S, aud: "authenticated" })).toBe(NOW_S);
  });

  it("returns most recent amr.timestamp when auth_time is absent (Supabase GoTrue format)", () => {
    expect(
      readAuthTimeFromClaims({
        aud: "authenticated",
        amr: [{ method: "oauth", timestamp: NOW_S }],
      }),
    ).toBe(NOW_S);
  });

  it("returns the highest timestamp when amr has multiple entries", () => {
    const older = NOW_S - 3600;
    expect(
      readAuthTimeFromClaims({
        aud: "authenticated",
        amr: [
          { method: "oauth", timestamp: older },
          { method: "totp", timestamp: NOW_S },
        ],
      }),
    ).toBe(NOW_S);
  });

  it("returns null when neither auth_time nor amr is present", () => {
    expect(readAuthTimeFromClaims({ aud: "authenticated", sub: "user-1" })).toBeNull();
  });

  it("returns null when amr entries lack a timestamp field", () => {
    expect(
      readAuthTimeFromClaims({
        aud: "authenticated",
        amr: [{ method: "oauth" }],
      }),
    ).toBeNull();
  });

  it("returns null on an empty claims payload", () => {
    expect(readAuthTimeFromClaims({})).toBeNull();
  });

  it("auth_time wins over amr when both are present", () => {
    expect(
      readAuthTimeFromClaims({
        auth_time: NOW_S,
        amr: [{ method: "oauth", timestamp: NOW_S - 100 }],
      }),
    ).toBe(NOW_S);
  });
});
