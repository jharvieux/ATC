// #1601 — Prevention guarantee for proxy.ts tenant resolution.
//
// proxy.ts decides tenant identity on the platform domain from prefix lists.
// Historically those lists were inlined and the app/ route tree did not feed
// them, so a new tenant-scoped /api/foo route that was never added to the list
// did not fail — it silently resolved to the platform sentinel and ran in the
// wrong tenant. This test walks the actual app/api/** route tree and fails when
// any route is not declared in route-classification.ts. The failure message
// tells the author exactly what to do, so the misresolution can never ship
// silently again.

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyApiRoute,
  pathMatchesPrefix,
} from "@/lib/tenancy/route-classification";

const API_ROOT = fileURLToPath(
  new URL("../../../src/app/api", import.meta.url),
);

// Collect the URL pathname of every route.ts under app/api/**, converting
// [param] segments to a concrete placeholder and dropping Next.js route groups
// `(group)` (which don't appear in the URL).
function collectApiRoutePaths(dir: string, urlPrefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name === "route.ts") {
      out.push(urlPrefix || "/api");
    }
    if (!entry.isDirectory()) continue;
    const seg = entry.name;
    // Route groups `(x)` are organizational only — no URL segment.
    const nextPrefix = seg.startsWith("(") && seg.endsWith(")")
      ? urlPrefix
      : `${urlPrefix}/${seg.startsWith("[") ? "_param" : seg}`;
    out.push(...collectApiRoutePaths(join(dir, seg), nextPrefix));
  }
  return out;
}

describe("proxy route classification manifest (#1601)", () => {
  const routePaths = existsSync(API_ROOT)
    ? [...new Set(collectApiRoutePaths(API_ROOT, "/api"))].sort()
    : [];

  it("finds the api route tree (guards against a broken walk)", () => {
    // If this ever hits zero the walk is broken and every route would look
    // "classified" by vacuous truth — fail loudly instead.
    expect(routePaths.length).toBeGreaterThan(50);
  });

  it("classifies every app/api/** route (a new route MUST be declared)", () => {
    const unclassified = routePaths.filter(
      (p) => classifyApiRoute(p) === "unclassified",
    );
    expect(
      unclassified,
      unclassified.length === 0
        ? ""
        : `These api routes are not declared in ` +
            `src/lib/tenancy/route-classification.ts:\n  ${unclassified.join("\n  ")}\n\n` +
            `Add each to a bucket so proxy.ts resolves its tenant correctly:\n` +
            `  - CONSOLE_API_PREFIXES  — tenant-scoped operator route that must ` +
            `get a resolved tenant on the platform domain\n` +
            `  - CHAT_API_PREFIXES     — chat/memory surface\n` +
            `  - ADMIN_API_PREFIXES    — platform-admin route\n` +
            `  - AUTH_API_PREFIXES     — session-establishing auth route\n` +
            `  - PLATFORM_DEFAULT_API_PREFIXES — public/platform-level, or a ` +
            `route whose tenant is resolved by subdomain slug (NOT the platform ` +
            `domain). Forgetting this bucket is what makes a route misresolve to ` +
            `the platform sentinel — choose consciously.`,
    ).toEqual([]);
  });

  it("classifies each route into exactly one bucket (no ambiguous overlap)", () => {
    // A path landing in two buckets means proxy.ts's resolution order silently
    // decides — the manifest must be unambiguous.
    const buckets = {
      admin: ["/api/admin"],
      auth: ["/api/auth"],
      chat: ["/api/chat", "/api/memory"],
      console: [
        "/api/crm",
        "/api/bookings",
        "/api/quotes",
        "/api/groups",
        "/api/price-watches",
        "/api/tenant",
      ],
    };
    for (const p of routePaths) {
      const hits = Object.entries(buckets).filter(([, prefixes]) =>
        prefixes.some((b) => pathMatchesPrefix(p, b)),
      );
      expect(hits.length, `${p} matched buckets ${hits.map(([k]) => k).join(",")}`)
        .toBeLessThanOrEqual(1);
    }
  });

  it("does not let /api/tenant swallow the distinct /api/tenants group", () => {
    // Regression pin: exact-or-subpath matching, not bare startsWith.
    expect(classifyApiRoute("/api/tenant/billing")).toBe("console");
    expect(classifyApiRoute("/api/tenants")).toBe("platform-default");
    expect(classifyApiRoute("/api/tenants/abc/custom-domain")).toBe("platform-default");
  });
});
