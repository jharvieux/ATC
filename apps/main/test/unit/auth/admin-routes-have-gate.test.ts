// §26 — Compile-time-ish guarantee that every /api/admin/* route handler
// imports assertPlatformAdmin.
//
// Audit pass 2, Finding 4: the middleware gate is a shape-check only; full
// verification happens in the route handler. Without this test, a future
// PR can add /api/admin/<new-route>/route.ts and forget the handler-level
// gate — any authenticated Supabase user would then have admin access to
// that route.
//
// Acceptable exemptions (routes that intentionally use a different auth
// path) must be added to ADMIN_ROUTE_EXEMPTIONS below with justification.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ADMIN_ROOT = join(process.cwd(), "apps", "main", "src", "app", "api", "admin");

// Routes that legitimately use a different gate. Each entry MUST have a
// REASON comment. Empty by default — every admin route should call
// assertPlatformAdmin unless there's a strong reason not to.
const ADMIN_ROUTE_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
  // Bearer-only routes that pre-date the session gate. They check
  // MAIN_APP_ADMIN_API_KEY directly inside the handler and are called by
  // the RAG-side reconcile crons. The middleware admin gate accepts that
  // Bearer; the handler verifies it again. assertPlatformAdmin would
  // also accept the same Bearer, so they could be migrated — but the
  // double-check at the handler level is intentional.
  ["api/admin/tenants/route.ts", "Pre-existing bearer-only route; MAIN_APP_ADMIN_API_KEY checked in handler. See §8.3."],
  ["api/admin/platform-settings/route.ts", "Same shape as /api/admin/tenants. D-041."],
]);

function* walkRouteFiles(root: string, prefix = ""): Generator<{ relPath: string; absPath: string }> {
  for (const entry of readdirSync(root)) {
    const abs = join(root, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(abs).isDirectory()) {
      yield* walkRouteFiles(abs, rel);
    } else if (entry === "route.ts") {
      yield { relPath: rel, absPath: abs };
    }
  }
}

describe("§26 admin route gate coverage", () => {
  it("every /api/admin/**/route.ts imports assertPlatformAdmin (or is in the exemption list)", () => {
    const offenders: string[] = [];
    for (const { relPath, absPath } of walkRouteFiles(ADMIN_ROOT)) {
      const exemptionKey = `api/admin/${relPath}`;
      if (ADMIN_ROUTE_EXEMPTIONS.has(exemptionKey)) continue;

      const src = readFileSync(absPath, "utf8");
      const hasGate =
        src.includes("assertPlatformAdmin") ||
        // Some routes call a wrapper that itself calls assertPlatformAdmin.
        src.includes("withPlatformAdmin(") ||
        src.includes("withPlatformAdminAudit(");
      if (!hasGate) {
        offenders.push(relPath);
      }
    }
    expect(offenders, `Admin routes missing platform-admin gate:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });
});
