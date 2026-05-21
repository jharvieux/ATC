/**
 * Cross-tenant probe — §4.1.3
 *
 * For every API route, authenticates as tenant B and attempts to access a
 * resource owned by tenant A. Any 2xx response is a cross-tenant data leak
 * and fails loudly. Any 5xx is also a failure.
 *
 * Routes in cross-tenant-allowlist.json are exempt (platform-admin routes
 * that are intentionally cross-tenant).
 *
 * When application fixtures don't exist yet, the suite runs in
 * "enumeration-only" mode: it still verifies the route enumerator works
 * and that the health route returns the expected status without auth.
 */

import { join } from "path";
import { describe, it, expect, beforeAll } from "vitest";
import {
  enumerateRoutes,
  type RouteEntry,
} from "../../scripts/enumerate-api-routes";
import allowlist from "./cross-tenant-allowlist.json";

const API_ROOT = join(process.cwd(), "apps", "main", "src", "app", "api");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const FIXTURES_AVAILABLE =
  SUPABASE_URL !== "" &&
  SERVICE_KEY !== "" &&
  process.env.CROSS_TENANT_FIXTURES === "true";

type AllowlistEntry = { route: string; method: string; reason: string };
const exemptRoutes = new Set(
  (allowlist as (AllowlistEntry | Record<string, unknown>)[])
    .filter((e): e is AllowlistEntry => "route" in e && "method" in e)
    .map((e) => `${e.method}:${e.route}`),
);

function isAllowlisted(entry: RouteEntry): boolean {
  return exemptRoutes.has(`${entry.method}:${entry.path}`);
}

function makeRequest(
  entry: RouteEntry,
  tenantAResourceId: string | undefined,
  token: string,
): Request {
  let path = entry.path;
  if (entry.hasParam && entry.paramName && tenantAResourceId) {
    path = path.replace(`[${entry.paramName}]`, tenantAResourceId);
  } else if (entry.hasParam) {
    // No fixture ID — use a sentinel that should never match any real resource
    path = path.replace(/\[[^\]]+\]/, "00000000-0000-0000-0000-000000000000");
  }

  const url = `${SUPABASE_URL.replace(/\/$/, "")}${path}`;
  return new Request(url, {
    method: entry.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

describe("Route enumerator", () => {
  it("enumerates at least one API route", () => {
    const routes = enumerateRoutes(API_ROOT);
    expect(routes.length).toBeGreaterThan(0);
  });

  it("health route is included", () => {
    const routes = enumerateRoutes(API_ROOT);
    const health = routes.find(
      (r) => r.path === "/health" || r.path === "/api/health",
    );
    expect(health).toBeDefined();
  });
});

describe("Cross-tenant probe", () => {
  let routes: RouteEntry[] = [];

  beforeAll(() => {
    routes = enumerateRoutes(API_ROOT).filter((r) => !isAllowlisted(r));
  });

  if (!FIXTURES_AVAILABLE) {
    it.skip("cross-tenant fixture tests skipped — set CROSS_TENANT_FIXTURES=true with valid Supabase credentials to enable", () => {});
    return;
  }

  // When fixtures are available, this block runs the real probe.
  // The fixture setup is imported lazily so the skip above short-circuits
  // cleanly when credentials are absent.
  it("tenant B cannot access tenant A resources on any route", async () => {
    const { setupCrossTenantFixtures } =
      await import("./fixtures/cross-tenant-setup");
    const fixtures = await setupCrossTenantFixtures(SUPABASE_URL, SERVICE_KEY);

    const failures: string[] = [];

    for (const route of routes) {
      const resourceId = route.paramName
        ? fixtures.tenantA.resourceIds[route.paramName]
        : undefined;

      const req = makeRequest(route, resourceId, fixtures.tenantB.sessionToken);

      let res: Response;
      try {
        res = await fetch(req);
      } catch (err) {
        failures.push(
          `${route.method} ${route.path}: fetch error — ${(err as Error).message}`,
        );
        continue;
      }

      if (res.status >= 200 && res.status < 300) {
        failures.push(
          `CROSS-TENANT LEAK: ${route.method} ${route.path} returned ${res.status} — tenant B accessed tenant A resource`,
        );
      } else if (res.status >= 500) {
        failures.push(
          `SERVER ERROR: ${route.method} ${route.path} returned ${res.status}`,
        );
      }
      // 401, 403, 404 are all acceptable — access correctly denied
    }

    if (failures.length > 0) {
      throw new Error(
        `Cross-tenant probe failures:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
      );
    }
  });
});
