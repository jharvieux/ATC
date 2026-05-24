// BP09 — signServiceJwt contract tests.
//
// Behaviour under test (contract):
//   1. Output is a real JWT — three base64url segments joined by '.'.
//   2. Header carries alg=RS256 and the configured kid.
//   3. Payload carries tenant_id, scope, jti, iat, exp matching the inputs.
//   4. Each call produces a fresh jti (rag's verifier rejects reused JTIs
//      as replays; if signer ever cached the jti this test catches it).
//   5. Missing env vars throw clearly rather than producing a broken token.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  signServiceJwt,
  _resetSigningKeyCacheForTests,
} from "../../../src/lib/rag-auth/sign-service-jwt";

// Generate a real RSA 2048 keypair once per test file. Cheaper than embedding
// a hard-coded PEM (which is awkward to maintain and easy to corrupt during
// copy-paste).
let TEST_PRIVATE_KEY_PEM = "";
beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  TEST_PRIVATE_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

describe("signServiceJwt", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.SERVICE_JWT_PRIVATE_KEY = TEST_PRIVATE_KEY_PEM;
    process.env.SERVICE_JWT_KEY_ID = "test-key-v1";
    _resetSigningKeyCacheForTests();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    _resetSigningKeyCacheForTests();
  });

  it("returns a three-segment JWT", async () => {
    const jwt = await signServiceJwt({
      tenant_id: "00000000-0000-0000-0000-000000000001",
      scope: "read",
    });
    expect(jwt.split(".")).toHaveLength(3);
  });

  it("includes alg=RS256 and the configured kid in the header", async () => {
    const jwt = await signServiceJwt({
      tenant_id: "00000000-0000-0000-0000-000000000001",
      scope: "read",
    });
    const header = JSON.parse(Buffer.from(jwt.split(".")[0]!, "base64url").toString("utf8"));
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBe("test-key-v1");
  });

  it("includes tenant_id, scope, service_identifier in the payload", async () => {
    const jwt = await signServiceJwt({
      tenant_id: "00000000-0000-0000-0000-0000000000aa",
      scope: "write",
      service_identifier: "platform-admin",
    });
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));
    expect(payload.tenant_id).toBe("00000000-0000-0000-0000-0000000000aa");
    expect(payload.scope).toBe("write");
    expect(payload.service_identifier).toBe("platform-admin");
    expect(typeof payload.jti).toBe("string");
    expect(payload.jti.length).toBeGreaterThan(0);
    expect(payload.iat).toBeTypeOf("number");
    expect(payload.exp).toBeTypeOf("number");
    expect(payload.exp - payload.iat).toBeGreaterThan(0);
  });

  it("respects ttl_seconds override", async () => {
    const jwt = await signServiceJwt({
      tenant_id: "00000000-0000-0000-0000-000000000001",
      scope: "read",
      ttl_seconds: 60,
    });
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8"));
    expect(payload.exp - payload.iat).toBe(60);
  });

  it("emits a fresh jti on every call (no caching — rag verifier rejects replays)", async () => {
    const a = await signServiceJwt({ tenant_id: "00000000-0000-0000-0000-000000000001", scope: "read" });
    const b = await signServiceJwt({ tenant_id: "00000000-0000-0000-0000-000000000001", scope: "read" });
    const payloadA = JSON.parse(Buffer.from(a.split(".")[1]!, "base64url").toString("utf8"));
    const payloadB = JSON.parse(Buffer.from(b.split(".")[1]!, "base64url").toString("utf8"));
    expect(payloadA.jti).not.toBe(payloadB.jti);
  });

  it("throws clearly when SERVICE_JWT_PRIVATE_KEY is missing", async () => {
    delete process.env.SERVICE_JWT_PRIVATE_KEY;
    await expect(
      signServiceJwt({ tenant_id: "00000000-0000-0000-0000-000000000001", scope: "read" }),
    ).rejects.toThrow(/SERVICE_JWT_PRIVATE_KEY/);
  });

  it("throws clearly when SERVICE_JWT_KEY_ID is missing", async () => {
    delete process.env.SERVICE_JWT_KEY_ID;
    await expect(
      signServiceJwt({ tenant_id: "00000000-0000-0000-0000-000000000001", scope: "read" }),
    ).rejects.toThrow(/SERVICE_JWT_KEY_ID/);
  });
});
