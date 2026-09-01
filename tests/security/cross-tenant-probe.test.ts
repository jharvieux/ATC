/**
 * Cross-tenant probe — §4.1.3
 *
 * Authenticates as tenant B and probes every API route. When a known tenant-A
 * resource ID fits the route, the request targets it and any 2xx is a leak.
 * Other 2xx JSON responses are inspected for exact tenant-A fixture
 * identifiers; unreadable 2xx evidence fails closed.
 *
 * Explicitly public or intentionally cross-tenant routes are documented in
 * cross-tenant-allowlist.json and excluded from leak classification.
 *
 * Without a compatible application host, the suite runs in enumeration-only
 * mode and does not claim live cross-tenant acceptance.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";
import { describe, it, expect, beforeAll } from "vitest";
import {
  enumerateRoutes,
  type RouteEntry,
} from "../../scripts/enumerate-api-routes";
import {
  tenantFixtureEvidence,
  type CrossTenantFixtures,
  type TenantFixture,
  type TenantResourceIds,
} from "./fixtures/cross-tenant-setup";
import allowlist from "./cross-tenant-allowlist.json";

const API_ROOT = join(process.cwd(), "apps", "main", "src", "app", "api");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
// APP_BASE_URL is the deployed Next.js app (e.g. the Vercel preview URL).
// SUPABASE_URL is the Supabase project endpoint — these are two different
// origins and must not be used interchangeably. See issue #563.
const APP_BASE_URL = process.env.APP_BASE_URL ?? "";

const LIVE_PROBE_AVAILABLE =
  SUPABASE_URL !== "" &&
  SERVICE_KEY !== "" &&
  APP_BASE_URL !== "" &&
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

function routeUrl(
  appBaseUrl: string,
  entry: RouteEntry,
  tenantAResourceId: string | undefined,
): string {
  let path = entry.path;
  if (entry.hasParam && entry.paramName && tenantAResourceId) {
    path = path
      .replace(`[${entry.paramName}]`, tenantAResourceId)
      .replace(`[...${entry.paramName}]`, tenantAResourceId);
  }
  // Any parameter without a matching fixture uses a sentinel that should
  // never match a real resource. No bracketed placeholder may reach the host.
  path = path.replace(
    /\[[^\]]+\]/g,
    "00000000-0000-0000-0000-000000000000",
  );

  return new URL(path, `${appBaseUrl.replace(/\/+$/, "")}/`).toString();
}

function makeRequest(
  entry: RouteEntry,
  tenantAResourceId: string | undefined,
  token: string,
  appBaseUrl = APP_BASE_URL,
): Request {
  return new Request(routeUrl(appBaseUrl, entry, tenantAResourceId), {
    method: entry.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

async function requireLiveAppHealth(
  appBaseUrl: string,
  fetchHealth: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchHealth(new URL("/api/health", appBaseUrl));
  } catch (error) {
    throw new Error(`Live app health sentinel request failed: ${(error as Error).message}`);
  }
  if (response.status !== 200) {
    throw new Error(`Live app health sentinel returned ${response.status}; expected 200`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Live app health sentinel did not return JSON");
  }
  const health = body as { status?: unknown; service?: unknown; commit?: unknown };
  const commit = typeof health.commit === "string" ? health.commit.trim() : "";
  if (health.status !== "ok" || health.service !== "main" || commit === "" || commit.toLowerCase() === "unknown") {
    throw new Error("Live app health sentinel did not identify a concrete main-app commit");
  }
  return commit;
}

async function requireTenantOwnBookingRead(
  appBaseUrl: string,
  bookingId: string,
  token: string,
  fetchBooking: typeof fetch = fetch,
): Promise<void> {
  const request = makeRequest({
    method: "GET",
    path: "/api/bookings/[id]",
    hasParam: true,
    paramName: "id",
    filePath: "apps/main/src/app/api/bookings/[id]/route.ts",
  }, bookingId, token, appBaseUrl);

  let response: Response;
  try {
    response = await fetchBooking(request);
  } catch (error) {
    throw new Error(`Tenant-B own-booking positive control request failed: ${(error as Error).message}`);
  }
  if (response.status !== 200) {
    throw new Error(`Tenant-B own-booking positive control returned ${response.status}; expected 200`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("+json")) {
    throw new Error("Tenant-B own-booking positive control did not return JSON");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Tenant-B own-booking positive control returned unreadable JSON");
  }
  const returnedId = (body as { booking?: { id?: unknown } }).booking?.id;
  if (returnedId !== bookingId) {
    throw new Error(`Tenant-B own-booking positive control returned booking.id=${String(returnedId)}; expected ${bookingId}`);
  }
}

function containsKnownIdentifier(value: unknown, knownIdentifiers: Set<string>): boolean {
  if (typeof value === "string") {
    for (const identifier of knownIdentifiers) {
      if (value.includes(identifier)) return true;
    }
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsKnownIdentifier(entry, knownIdentifiers));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, entry]) => containsKnownIdentifier(key, knownIdentifiers) || containsKnownIdentifier(entry, knownIdentifiers),
    );
  }
  return false;
}

async function probeFailure(
  route: RouteEntry,
  response: Response,
  requestTargetsKnownTenantAResource: boolean,
  knownTenantAIdentifiers: Set<string>,
): Promise<string | undefined> {
  if (response.status >= 500) {
    return `SERVER ERROR: ${route.method} ${route.path} returned ${response.status}`;
  }
  if (response.status < 200 || response.status >= 300) return undefined;
  if (requestTargetsKnownTenantAResource) {
    return `CROSS-TENANT LEAK: ${route.method} ${route.path} returned ${response.status} for a known tenant-A resource`;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("+json")) {
    return `UNVERIFIABLE 2XX: ${route.method} ${route.path} returned ${response.status} without JSON evidence`;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return `UNVERIFIABLE 2XX: ${route.method} ${route.path} returned unreadable JSON`;
  }
  if (containsKnownIdentifier(body, knownTenantAIdentifiers)) {
    return `CROSS-TENANT LEAK: ${route.method} ${route.path} returned a known tenant-A identifier`;
  }
  return undefined;
}

async function probeRoute(
  appBaseUrl: string,
  route: RouteEntry,
  tenantAResourceId: string | undefined,
  token: string,
  knownTenantAIdentifiers: Set<string>,
  fetchProbe: typeof fetch = fetch,
): Promise<string | undefined> {
  const request = makeRequest(route, tenantAResourceId, token, appBaseUrl);
  let response: Response;
  try {
    response = await fetchProbe(request);
  } catch (error) {
    return `${route.method} ${route.path}: fetch error — ${(error as Error).message}`;
  }
  return probeFailure(
    route,
    response,
    tenantAResourceId !== undefined,
    knownTenantAIdentifiers,
  );
}

function matchingTenantResourceId(
  route: RouteEntry,
  resourceIds: TenantResourceIds,
): string | undefined {
  if (!route.hasParam || route.paramName !== "id") return undefined;
  if (route.path.startsWith("/api/bookings/[id]")) return resourceIds.booking;
  if (route.path.startsWith("/api/chat/conversations/[id]")) return resourceIds.conversation;
  if (route.path.startsWith("/api/crm/contacts/[id]")) return resourceIds.contact;
  return undefined;
}

async function probeTenantIsolationRoutes(
  appBaseUrl: string,
  routes: RouteEntry[],
  fixtures: CrossTenantFixtures,
  fetchProbe: typeof fetch = fetch,
): Promise<string[]> {
  await requireTenantOwnBookingRead(
    appBaseUrl,
    fixtures.tenantB.resourceIds.booking,
    fixtures.tenantB.sessionToken,
    fetchProbe,
  );

  const failures: string[] = [];
  const knownTenantAIdentifiers = new Set(fixtures.tenantA.knownIds);
  for (const route of routes) {
    const resourceId = matchingTenantResourceId(
      route,
      fixtures.tenantA.resourceIds,
    );
    const failure = await probeRoute(
      appBaseUrl,
      route,
      resourceId,
      fixtures.tenantB.sessionToken,
      knownTenantAIdentifiers,
      fetchProbe,
    );
    if (failure) failures.push(failure);
  }
  return failures;
}

describe("Route enumerator", () => {
  it("enumerates at least one API route", () => {
    const routes = enumerateRoutes(API_ROOT);
    expect(routes.length).toBeGreaterThan(0);
  });

  it("health route is included", () => {
    const routes = enumerateRoutes(API_ROOT);
    const health = routes.find((r) => r.path === "/api/health");
    expect(health).toBeDefined();
  });

  it("emits the deployed /api paths for static and dynamic handlers", () => {
    const routes = enumerateRoutes(API_ROOT);
    expect(routes.every((route) => route.path.startsWith("/api/"))).toBe(true);
    expect(routes.some((route) => route.path === "/api/bookings/[id]"))
      .toBe(true);
  });

  it("keeps catch-all handlers under /api and substitutes their probe segment", () => {
    const apiRoot = mkdtempSync(join(tmpdir(), "api-route-enumerator-"));
    try {
      const routeDir = join(apiRoot, "files", "[...rest]");
      mkdirSync(routeDir, { recursive: true });
      writeFileSync(join(routeDir, "route.ts"), "export async function GET() {}\n");
      const [route] = enumerateRoutes(apiRoot);
      expect(route).toMatchObject({
        method: "GET",
        path: "/api/files/[...rest]",
        hasParam: true,
        paramName: "rest",
      });
      expect(routeUrl("https://app.example.test", route, "tenant-a-path"))
        .toBe("https://app.example.test/api/files/tenant-a-path");
    } finally {
      rmSync(apiRoot, { recursive: true, force: true });
    }
  });

  it("exempts the public health sentinel from leak classification for a stated reason", () => {
    const health = (allowlist as (AllowlistEntry | Record<string, unknown>)[])
      .find((entry): entry is AllowlistEntry =>
        "route" in entry && entry.route === "/api/health" && entry.method === "GET",
      );
    expect(health?.reason).toMatch(/public health sentinel/i);
    expect(isAllowlisted({
      method: "GET",
      path: "/api/health",
      hasParam: false,
      filePath: "apps/main/src/app/api/health/route.ts",
    })).toBe(true);
  });

  it("pins probe URLs to real /api paths with or without a trailing base slash", () => {
    const route: RouteEntry = {
      method: "GET",
      path: "/api/bookings/[id]",
      hasParam: true,
      paramName: "id",
      filePath: "apps/main/src/app/api/bookings/[id]/route.ts",
    };
    for (const base of ["https://app.example.test", "https://app.example.test/"]) {
      expect(routeUrl(base, route, "tenant-a-booking"))
        .toBe("https://app.example.test/api/bookings/tenant-a-booking");
    }

    expect(routeUrl("https://app.example.test", {
      ...route,
      path: "/api/forums/[forumId]/threads/[threadId]",
      paramName: "forumId",
    }, "tenant-a-forum")).toBe(
      "https://app.example.test/api/forums/tenant-a-forum/threads/00000000-0000-0000-0000-000000000000",
    );
  });

  it("requires the live health sentinel to identify a concrete hosted commit", async () => {
    let healthUrl = "";
    const ok: typeof fetch = async (request) => {
      healthUrl = request.toString();
      return new Response(JSON.stringify({
        status: "ok",
        service: "main",
        commit: "hosted-sha",
      }), { status: 200 });
    };
    await expect(requireLiveAppHealth("https://app.example.test", ok))
      .resolves.toBe("hosted-sha");
    expect(healthUrl).toBe("https://app.example.test/api/health");

    for (const response of [
      new Response("not found", { status: 404 }),
      new Response("server error", { status: 500 }),
      new Response("not json", { status: 200 }),
      new Response(JSON.stringify({ status: "ok", service: "main", commit: "unknown" }), { status: 200 }),
      new Response(JSON.stringify({ status: "ok", service: "main", commit: "" }), { status: 200 }),
    ]) {
      await expect(requireLiveAppHealth("https://app.example.test", async () => response.clone()))
        .rejects.toThrow(/health sentinel/i);
    }
    await expect(requireLiveAppHealth("https://app.example.test", async () => {
      throw new Error("network down");
    })).rejects.toThrow(/network down/);
  });

  it("reads tenant B's own booking before probing tenant A resources", async () => {
    const tenant = (prefix: string): TenantFixture => ({
      tenantId: `${prefix}-tenant`,
      userId: `${prefix}-user`,
      sessionToken: `${prefix}-token`,
      knownIds: [`${prefix}-tenant`, `${prefix}-booking`],
      resourceIds: {
        booking: `${prefix}-booking`,
        conversation: `${prefix}-conversation`,
        contact: `${prefix}-contact`,
      },
    });
    const fixtures: CrossTenantFixtures = {
      tenantA: tenant("tenant-a"),
      tenantB: tenant("tenant-b"),
    };
    const route: RouteEntry = {
      method: "GET",
      path: "/api/bookings/[id]",
      hasParam: true,
      paramName: "id",
      filePath: "apps/main/src/app/api/bookings/[id]/route.ts",
    };
    const requests: Request[] = [];
    const failures = await probeTenantIsolationRoutes(
      "https://app.example.test",
      [route],
      fixtures,
      async (request) => {
        const resolved = request instanceof Request ? request : new Request(request);
        requests.push(resolved);
        if (requests.length === 1) {
          return Response.json({ booking: { id: fixtures.tenantB.resourceIds.booking } });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    );

    expect(failures).toEqual([]);
    expect(requests.map((request) => request.url)).toEqual([
      "https://app.example.test/api/bookings/tenant-b-booking",
      "https://app.example.test/api/bookings/tenant-a-booking",
    ]);
    expect(requests[0].headers.get("authorization")).toBe("Bearer tenant-b-token");
  });

  it("fails loudly when tenant B's own-booking control is not exact readable evidence", async () => {
    const responses = [
      new Response("not found", { status: 404 }),
      new Response("server error", { status: 500 }),
      new Response("not json", { status: 200 }),
      new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
      Response.json({ booking: { id: "wrong-booking" } }),
      Response.json({ booking: {} }),
    ];
    for (const response of responses) {
      await expect(requireTenantOwnBookingRead(
        "https://app.example.test",
        "tenant-b-booking",
        "tenant-b-token",
        async () => response.clone(),
      )).rejects.toThrow(/own-booking positive control/i);
    }
    await expect(requireTenantOwnBookingRead(
      "https://app.example.test",
      "tenant-b-booking",
      "tenant-b-token",
      async () => { throw new Error("network down"); },
    )).rejects.toThrow(/own-booking positive control.*network down/i);
  });

  it("classifies live responses by known tenant-A evidence", async () => {
    const dynamicRoute: RouteEntry = {
      method: "GET",
      path: "/api/bookings/[id]",
      hasParam: true,
      paramName: "id",
      filePath: "apps/main/src/app/api/bookings/[id]/route.ts",
    };
    const staticRoute: RouteEntry = {
      ...dynamicRoute,
      path: "/api/bookings",
      hasParam: false,
      paramName: undefined,
    };
    const tenantAId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const tenantBId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const knownTenantAIdentifiers = new Set([tenantAId]);
    const json = (body: unknown, status = 200) => Response.json(body, { status });

    let requestedUrl = "";
    const dynamicLeak = await probeRoute(
      "https://app.example.test",
      dynamicRoute,
      tenantAId,
      "tenant-b-token",
      knownTenantAIdentifiers,
      async (request) => {
        requestedUrl = request instanceof Request ? request.url : request.toString();
        return json({ id: tenantBId });
      },
    );
    expect(requestedUrl).toBe(`https://app.example.test/api/bookings/${tenantAId}`);
    expect(dynamicLeak).toMatch(/known tenant-A resource/);

    await expect(probeRoute(
      "https://app.example.test",
      staticRoute,
      undefined,
      "tenant-b-token",
      knownTenantAIdentifiers,
      async () => json({ bookings: [{ id: tenantBId }] }),
    )).resolves.toBeUndefined();
    await expect(probeRoute(
      "https://app.example.test",
      staticRoute,
      undefined,
      "tenant-b-token",
      knownTenantAIdentifiers,
      async () => json({ bookings: [{ id: tenantAId }] }),
    )).resolves.toMatch(/known tenant-A identifier/);
    await expect(probeRoute(
      "https://app.example.test",
      staticRoute,
      undefined,
      "tenant-b-token",
      knownTenantAIdentifiers,
      async () => json({ href: `/api/bookings/${tenantAId}` }),
    )).resolves.toMatch(/known tenant-A identifier/);

    for (const deniedStatus of [401, 403, 404]) {
      await expect(probeFailure(
        dynamicRoute,
        new Response("denied", { status: deniedStatus }),
        true,
        knownTenantAIdentifiers,
      )).resolves.toBeUndefined();
    }
    await expect(probeFailure(
      staticRoute,
      new Response("server error", { status: 500 }),
      false,
      knownTenantAIdentifiers,
    )).resolves.toMatch(/SERVER ERROR/);
    await expect(probeFailure(
      staticRoute,
      new Response("not json", { status: 200 }),
      false,
      knownTenantAIdentifiers,
    )).resolves.toMatch(/UNVERIFIABLE 2XX/);
    await expect(probeFailure(
      staticRoute,
      new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
      false,
      knownTenantAIdentifiers,
    )).resolves.toMatch(/unreadable JSON/);
    await expect(probeRoute(
      "https://app.example.test",
      staticRoute,
      undefined,
      "tenant-b-token",
      knownTenantAIdentifiers,
      async () => { throw new Error("network down"); },
    )).resolves.toMatch(/network down/);
  });

  it("targets seeded IDs only on their matching route families", () => {
    const resourceIds = {
      booking: "tenant-a-booking",
      conversation: "tenant-a-conversation",
      contact: "tenant-a-contact",
    };
    const route = (path: string): RouteEntry => ({
      method: "GET",
      path,
      hasParam: true,
      paramName: "id",
      filePath: `apps/main/src/app${path}/route.ts`,
    });
    expect(matchingTenantResourceId(route("/api/bookings/[id]"), resourceIds))
      .toBe(resourceIds.booking);
    expect(matchingTenantResourceId(route("/api/chat/conversations/[id]"), resourceIds))
      .toBe(resourceIds.conversation);
    expect(matchingTenantResourceId(route("/api/crm/contacts/[id]/timeline"), resourceIds))
      .toBe(resourceIds.contact);
    expect(matchingTenantResourceId(route("/api/quotes/[id]"), resourceIds))
      .toBeUndefined();
  });

  it("exposes every seeded row ID for static response inspection", () => {
    const seed = {
      tenantId: "tenant-a",
      userPubId: "user-a",
      bookingId: "booking-a",
      convId: "conversation-a",
      contactId: "contact-a",
    };
    expect(tenantFixtureEvidence(seed, "auth-user-a")).toEqual({
      knownIds: [
        "tenant-a",
        "user-a",
        "auth-user-a",
        "booking-a",
        "conversation-a",
        "contact-a",
      ],
      resourceIds: {
        booking: "booking-a",
        conversation: "conversation-a",
        contact: "contact-a",
      },
    });
  });
});

describe("Cross-tenant probe", () => {
  let routes: RouteEntry[] = [];

  beforeAll(() => {
    routes = enumerateRoutes(API_ROOT).filter((r) => !isAllowlisted(r));
  });

  if (!LIVE_PROBE_AVAILABLE) {
    it.skip("live cross-tenant requests skipped — APP_BASE_URL or fixture credentials unavailable; route enumeration completed", () => {});
    return;
  }

  // When fixtures are available, this block runs the real probe.
  // The fixture setup is imported lazily so the skip above short-circuits
  // cleanly when credentials are absent.
  it("tenant B cannot access tenant A resources on any route", async () => {
    await requireLiveAppHealth(APP_BASE_URL);

    const { setupCrossTenantFixtures } =
      await import("./fixtures/cross-tenant-setup");
    const fixtures = await setupCrossTenantFixtures(SUPABASE_URL, SERVICE_KEY);
    const failures = await probeTenantIsolationRoutes(
      APP_BASE_URL,
      routes,
      fixtures,
    );

    if (failures.length > 0) {
      throw new Error(
        `Cross-tenant probe failures:\n${failures.map((f) => `  - ${f}`).join("\n")}`,
      );
    }
  });
});
