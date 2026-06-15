// §26.3 — readAuthTime must extract the authentication timestamp from
// Supabase JWTs. GoTrue does not emit auth_time; the equivalent is
// amr[].timestamp. The sensitive-route session-age check depends on this:
// if readAuthTime returns null, every sensitive route denies unconditionally.

import { describe, it, expect } from "vitest";
import { readAuthTime } from "@/lib/auth/assert-permission";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

const NOW_S = Math.floor(Date.now() / 1000);

describe("readAuthTime", () => {
  it("returns auth_time when present (custom hook compatibility)", () => {
    const jwt = makeJwt({ auth_time: NOW_S, aud: "authenticated" });
    expect(readAuthTime(jwt)).toBe(NOW_S);
  });

  it("returns most recent amr.timestamp when auth_time is absent (Supabase GoTrue format)", () => {
    const jwt = makeJwt({
      aud: "authenticated",
      amr: [{ method: "oauth", timestamp: NOW_S }],
    });
    expect(readAuthTime(jwt)).toBe(NOW_S);
  });

  it("returns the highest timestamp when amr has multiple entries", () => {
    const older = NOW_S - 3600;
    const jwt = makeJwt({
      aud: "authenticated",
      amr: [
        { method: "oauth", timestamp: older },
        { method: "totp", timestamp: NOW_S },
      ],
    });
    expect(readAuthTime(jwt)).toBe(NOW_S);
  });

  it("returns null when neither auth_time nor amr is present", () => {
    const jwt = makeJwt({ aud: "authenticated", sub: "user-1" });
    expect(readAuthTime(jwt)).toBeNull();
  });

  it("returns null when amr entries lack a timestamp field", () => {
    const jwt = makeJwt({
      aud: "authenticated",
      amr: [{ method: "oauth" }],
    });
    expect(readAuthTime(jwt)).toBeNull();
  });

  it("returns null for a malformed JWT", () => {
    expect(readAuthTime("not.a.jwt.with.too.many.dots")).toBeNull();
    expect(readAuthTime("onlyone")).toBeNull();
    expect(readAuthTime("two.parts")).toBeNull();
  });

  it("auth_time wins over amr when both are present", () => {
    const jwt = makeJwt({
      auth_time: NOW_S,
      amr: [{ method: "oauth", timestamp: NOW_S - 100 }],
    });
    expect(readAuthTime(jwt)).toBe(NOW_S);
  });
});
