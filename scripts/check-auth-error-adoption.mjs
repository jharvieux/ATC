// #556 regression guard — every API route handler that calls assertPermission
// must also route auth failures through respondToAuthError(err), so a thrown
// AuthForbidden/AuthReauthRequired/etc. maps to the correct 401/403 instead of
// leaking a message or surfacing as a generic 500.
//
// Pure static check (no model, no network): scan route.ts files under the
// main app's API tree; flag any that call assertPermission( but never
// respondToAuthError(. Wired into `pnpm verify` and CI.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = "apps/main/src/app/api";
const CALLS_ASSERT = /\bassertPermission\s*\(/;
const CALLS_RESPOND = /\brespondToAuthError\s*\(/;

const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      walk(p);
    } else if (entry === "route.ts") {
      const src = readFileSync(p, "utf8");
      if (CALLS_ASSERT.test(src) && !CALLS_RESPOND.test(src)) {
        offenders.push(p);
      }
    }
  }
}

walk(API_ROOT);

if (offenders.length > 0) {
  console.error(
    `✖ ${offenders.length} route(s) call assertPermission but do not route through respondToAuthError:`,
  );
  for (const o of offenders) console.error("  - " + o);
  console.error(
    "\nWrap the handler so auth errors reach `return respondToAuthError(err)`.\n" +
      "See apps/main/src/lib/auth/respond.ts and an adopter such as\n" +
      "apps/main/src/app/api/price-watches/route.ts.",
  );
  process.exit(1);
}

console.log("✔ auth-error adoption: all assertPermission routes map errors through respondToAuthError.");
