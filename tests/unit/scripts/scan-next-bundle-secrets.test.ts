// #1637 — unit tests for the .next bundle secret scanner.
//
// The load-bearing behavior: DECODE the JWT and only fail on role==="service_role".
// A shape-only regex would false-positive on the anon key (which is SUPPOSED to
// be in the bundle) — this test pins that the anon/authenticated roles pass and
// only service_role is caught.

import { describe, it, expect } from "vitest";
import { findServiceRoleLeaks } from "../../../scripts/scan-next-bundle-secrets";

function jwt(role: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ role, iss: "supabase" })).toString("base64url");
  return `${header}.${payload}.c2lnbmF0dXJl`;
}

const roles = (src: string) => findServiceRoleLeaks("x.js", src).map((l) => l.role);

describe("findServiceRoleLeaks", () => {
  it("flags a service_role JWT embedded in bundle output", () => {
    expect(roles(`var k="${jwt("service_role")}";`)).toEqual(["service_role"]);
  });

  it("does NOT flag the anon key (role anon is client-safe)", () => {
    expect(roles(`var k="${jwt("anon")}";`)).toEqual([]);
  });

  it("does NOT flag an authenticated-role token", () => {
    expect(roles(`var k="${jwt("authenticated")}";`)).toEqual([]);
  });

  it("ignores non-JWT eyJ-lookalikes that don't decode to a role", () => {
    expect(roles(`const s = "eyJhbGc.notbase64json.sig";`)).toEqual([]);
  });

  it("dedupes a repeated service_role token to a single finding", () => {
    const t = jwt("service_role");
    expect(roles(`a="${t}";b="${t}";`)).toEqual(["service_role"]);
  });
});
