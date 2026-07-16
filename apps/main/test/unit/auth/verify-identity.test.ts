// #1585 — verifyIdentity is the trust boundary for the inner auth layers.
//
// WHY THESE TESTS MATTER: #1585 replaced three GoTrue network verifications
// with local JWKS signature checks. The whole change is only sound if "local"
// still means "cryptographically verified". Every test below asserts a way the
// optimization could have quietly become a fail-OPEN — a forged signature
// accepted, an expired token honoured, a claims payload trusted without a
// signature behind it. If someone later "simplifies" verifyIdentity into a
// decodeJwt() that skips getClaims(), these tests must go red.

import { describe, it, expect, vi } from "vitest";
import { verifyIdentity } from "@/lib/auth/verify-identity";
import type { SupabaseClient } from "@supabase/supabase-js";

const AUTH_USER_ID = "auth-user-uuid-1234";

// A realistic 3-segment JWT: header/payload are valid base64url JSON (so a
// bare decodeJwt() decodes it successfully), but the signature segment is
// not a real signature over any key. Every "fails closed" test below asserts
// that on a bad signature; getClaims() is mocked to report exactly that. If
// verifyIdentity were ever "simplified" into a decode-only check, this TOKEN
// must not make that mutant pass by accident — it has to actually decode.
const TOKEN = `${Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url")}.${Buffer.from(
  JSON.stringify({ sub: AUTH_USER_ID, exp: 9999999999 }),
).toString("base64url")}.invalidsignature`;

function makeClient(opts: {
  getClaims?: unknown;
  session?: unknown;
}): { client: SupabaseClient; getClaims: ReturnType<typeof vi.fn> } {
  const getClaims = vi.fn().mockResolvedValue(
    opts.getClaims ?? { data: { claims: { sub: AUTH_USER_ID } }, error: null },
  );
  const client = {
    auth: {
      getClaims,
      getSession: vi
        .fn()
        .mockResolvedValue(
          opts.session ?? { data: { session: { access_token: TOKEN } }, error: null },
        ),
    },
  } as unknown as SupabaseClient;
  return { client, getClaims };
}

describe("verifyIdentity", () => {
  it("returns the identity asserted by a signature-verified JWT", async () => {
    const { client } = makeClient({});
    const identity = await verifyIdentity(client, TOKEN);
    expect(identity).toEqual({
      authUserId: AUTH_USER_ID,
      accessToken: TOKEN,
      claims: { sub: AUTH_USER_ID },
    });
  });

  // The core anti-forgery property. getClaims() surfaces a bad ES256 signature
  // as an error; if verifyIdentity ever read `claims` without checking `error`,
  // a forged token would authenticate. That is the exact bug this guards.
  it("fails closed when the signature does not verify", async () => {
    const { client } = makeClient({
      getClaims: { data: null, error: { name: "AuthInvalidJwtError", message: "Invalid JWT signature" } },
    });
    expect(await verifyIdentity(client, TOKEN)).toBeNull();
  });

  // getClaims() rejects exp-in-the-past itself. An expired session must not be
  // honoured just because the signature is intact.
  it("fails closed on an expired token", async () => {
    const { client } = makeClient({
      getClaims: { data: null, error: { name: "AuthInvalidJwtError", message: "JWT has expired" } },
    });
    expect(await verifyIdentity(client, TOKEN)).toBeNull();
  });

  // Defence in depth. auth-js today always nulls `data` when it sets `error`,
  // which makes the `error ||` guard look redundant — so a future "cleanup"
  // could drop it with every test still green. If auth-js ever returns a
  // decoded payload ALONGSIDE a verification error, dropping that guard means
  // trusting claims whose signature check failed. Pin it: error wins, always,
  // whatever `data` holds.
  it("prefers the error over any claims returned with it", async () => {
    const { client } = makeClient({
      getClaims: {
        data: { claims: { sub: AUTH_USER_ID } },
        error: { name: "AuthInvalidJwtError", message: "Invalid JWT signature" },
      },
    });
    expect(await verifyIdentity(client, TOKEN)).toBeNull();
  });

  it("fails closed when there is no session at all", async () => {
    const { client } = makeClient({ getClaims: { data: null, error: null } });
    expect(await verifyIdentity(client)).toBeNull();
  });

  // A verified signature over claims carrying no usable `sub` is not an
  // identity. Returning it would hand callers `undefined` as an auth_user_id,
  // which downstream .eq("auth_user_id", undefined) filters could turn into an
  // unscoped match.
  it.each([
    ["missing sub", {}],
    ["empty sub", { sub: "" }],
    ["non-string sub", { sub: 12345 }],
  ])("fails closed on verified claims with a %s", async (_label, claims) => {
    const { client } = makeClient({ getClaims: { data: { claims }, error: null } });
    expect(await verifyIdentity(client, TOKEN)).toBeNull();
  });

  // Guards the §26.3 auth_time contract: callers read auth_time from the token
  // verifyIdentity returns. If that were a DIFFERENT token than the one whose
  // signature was checked, the re-auth gate would be reading attacker-supplied
  // bytes — the precise footgun #1585 removed from assert-permission.
  it("returns the exact token whose signature was verified", async () => {
    const { client, getClaims } = makeClient({});
    const identity = await verifyIdentity(client, TOKEN);
    expect(getClaims).toHaveBeenCalledWith(TOKEN);
    expect(identity?.accessToken).toBe(TOKEN);
  });

  // Cookie callers pass no explicit token; getClaims() must still be invoked so
  // the session's token gets verified rather than merely parsed.
  it("verifies the session token for cookie callers", async () => {
    const { client, getClaims } = makeClient({});
    const identity = await verifyIdentity(client);
    expect(getClaims).toHaveBeenCalledWith(undefined);
    expect(identity?.accessToken).toBe(TOKEN);
  });

  it("fails closed when claims verify but no access token can be resolved", async () => {
    const { client } = makeClient({ session: { data: { session: null }, error: null } });
    expect(await verifyIdentity(client)).toBeNull();
  });
});
