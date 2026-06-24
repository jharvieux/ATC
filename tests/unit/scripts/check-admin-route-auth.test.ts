// #1393/G5 — unit tests for the admin-route auth guard.
//
// Pins the presence-check semantics that matter: a route is gated iff its
// source contains one of the surface's authority tokens. If the token list or
// the matcher regressed (e.g. back to a bare "service_identifier" mention an
// import/comment could satisfy), an ungated admin route could slip through.

import { describe, it, expect } from "vitest";
import {
  routeHasAuthorityToken,
  ADMIN_SURFACES,
} from "../../../scripts/check-admin-route-auth";

const mainTokens = ADMIN_SURFACES.find((s) => s.dir.includes("apps/main"))!.tokens;
const ragTokens = ADMIN_SURFACES.find((s) => s.dir.includes("apps/rag"))!.tokens;

describe("routeHasAuthorityToken — main admin surface", () => {
  it("gates a route calling an assertPlatformAdmin* helper", () => {
    expect(routeHasAuthorityToken(`await assertPlatformAdminArea(req, "x");`, mainTokens)).toBe(true);
  });

  it("gates the service-bearer MAIN_APP_ADMIN_API_KEY compare path", () => {
    expect(
      routeHasAuthorityToken(`constantTimeEqual(tok, process.env.MAIN_APP_ADMIN_API_KEY)`, mainTokens),
    ).toBe(true);
  });

  it("rejects a route with no authority token", () => {
    expect(routeHasAuthorityToken(`export const GET = async () => Response.json({});`, mainTokens)).toBe(false);
  });
});

describe("routeHasAuthorityToken — rag admin surface", () => {
  it("gates the negative deny-form check", () => {
    expect(
      routeHasAuthorityToken(`if (ctx.service_identifier !== "platform-admin") return r;`, ragTokens),
    ).toBe(true);
  });

  it("gates the positive proceed-form check", () => {
    expect(
      routeHasAuthorityToken(`if (ctx.service_identifier === "platform-admin") { /* ok */ }`, ragTokens),
    ).toBe(true);
  });

  it("rejects a bare service_identifier mention without the platform-admin comparison", () => {
    // This is the tightening from the d091 audit: an import or a comment that
    // merely names service_identifier must NOT satisfy the guard.
    expect(routeHasAuthorityToken(`const id = ctx.service_identifier;`, ragTokens)).toBe(false);
  });

  it("rejects a route with withServiceAuth but no platform-admin gate", () => {
    expect(
      routeHasAuthorityToken(`export const POST = withServiceAuth(async () => Response.json({}));`, ragTokens),
    ).toBe(false);
  });
});
