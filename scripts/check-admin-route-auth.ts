// Admin-route auth guard (epic #1393 / G5; closes the F-auth-02 + F-rag-auth-02
// structural gap from the Day-1 scan, D-296).
//
// Every route under apps/*/src/app/api/admin/** must assert platform-admin
// authority IN THE HANDLER. The middleware admin gate (proxy.ts) is only a
// cookie SHAPE check — real authority is the per-route assertion. So a new
// admin route added without one is reachable by any authenticated user. tsc
// can't see this; only a static presence sweep catches it (the same shape as
// check-permission-matrix, which covers the assertPermission surface — a
// different auth model that does NOT apply to admin routes).
//
// A route is considered gated if it references one of the app's authority
// tokens below. This is a presence check, not a flow analysis: a file that
// mentions the token but doesn't actually call it could still slip through —
// but that is a far smaller, more visible gap than a route with no gate at
// all, and the audit agents catch the former at PR time.
//
// BASELINE: scripts/admin-route-auth-baseline.txt lists routes intentionally
// exempt (e.g. an admin health check). The check fails on NEW ungated routes
// only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts/admin-route-auth-baseline.txt");

// Per-app: a route is gated if it references ANY of these tokens.
// main — RBAC/platform-admin asserts + the service-to-service bearer compare.
// rag  — withServiceAuth authenticates ANY service JWT, so the platform-admin
//        discriminator is the `service_identifier` check; that token is required.
export const ADMIN_SURFACES: { dir: string; tokens: string[] }[] = [
  {
    dir: "apps/main/src/app/api/admin",
    tokens: [
      "assertPlatformAdmin",
      "assertPlatformAdminArea",
      "assertPlatformRole",
      "assertSuperadmin",
      "MAIN_APP_ADMIN_API_KEY",
    ],
  },
  {
    dir: "apps/rag/src/app/api/admin",
    // Exact check substrings (not a bare "service_identifier" mention) so a
    // comment or import can't satisfy the guard. Accept both comparison
    // directions: routes today use the negative deny-form (`!== → 403`), but a
    // positive proceed-form (`===`) is an equally valid gate.
    tokens: [
      'service_identifier !== "platform-admin"',
      'service_identifier === "platform-admin"',
    ],
  },
];

// A route is gated if its source contains any of the surface's authority
// tokens. Presence check (not flow analysis) — see the header note. Exported
// for the unit test that pins this semantics.
export function routeHasAuthorityToken(content: string, tokens: string[]): boolean {
  return tokens.some((t) => content.includes(t));
}

function walkRoutes(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(d, entry.name));
      else if (entry.name === "route.ts" || entry.name === "route.tsx") {
        out.push(path.join(d, entry.name));
      }
    }
  };
  walk(dir);
  return out;
}

function loadBaseline(): Set<string> {
  if (!fs.existsSync(BASELINE_FILE)) return new Set();
  return new Set(
    fs
      .readFileSync(BASELINE_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}

function main(): void {
  const baseline = loadBaseline();
  const ungated: string[] = [];
  let scanned = 0;

  for (const surface of ADMIN_SURFACES) {
    const absDir = path.join(ROOT, surface.dir);
    const routes = walkRoutes(absDir);
    // Per-surface, not global: if one admin surface disappears (rename/restructure)
    // its routes must not silently fall out of coverage while the other surface
    // keeps the check green.
    if (routes.length === 0) {
      console.error(
        `Admin-route auth check: 0 route files under ${surface.dir}. ` +
          `If this surface was intentionally removed, update ADMIN_SURFACES in scripts/check-admin-route-auth.ts.`,
      );
      process.exit(1);
    }
    for (const file of routes) {
      scanned++;
      const rel = path.relative(ROOT, file);
      if (baseline.has(rel)) continue;
      const content = fs.readFileSync(file, "utf8");
      if (!routeHasAuthorityToken(content, surface.tokens)) {
        ungated.push(rel);
      }
    }
  }

  if (ungated.length > 0) {
    console.error(
      "Admin-route auth violations — admin routes with no platform-admin assertion:\n",
    );
    for (const f of ungated) console.error(`  ${f}`);
    console.error(
      `\n${ungated.length} admin route(s) under app/api/admin/** assert no platform-admin authority.`,
    );
    console.error(
      "Add an in-handler assertion (main: assertPlatformAdmin* / MAIN_APP_ADMIN_API_KEY compare; " +
        "rag: a service_identifier check against 'platform-admin'), or, if intentionally exempt, " +
        "add the path to scripts/admin-route-auth-baseline.txt with a reason.",
    );
    process.exit(1);
  }

  const baselineCount = baseline.size;
  console.log(
    `Admin-route auth check passed: ${scanned} admin route file(s) scanned, all assert platform-admin authority` +
      (baselineCount > 0 ? ` (${baselineCount} baselined exemption(s))` : "") +
      ".",
  );
}

main();
