// #562 regression guard — every server-component page that imports
// createServiceRoleClient must be inside the (admin) route group (covered by
// the AdminLayout assertPlatformAdmin gate) OR appear in the allowlist below
// with an explicit justification.
//
// This is the static Phase-1 implementation of the unauthenticated page-route
// probe described in issue #562. It would have blocked the #559 supervisor
// exposure at merge time rather than finding it in production.
//
// Pure static check (no model, no network). Wired into `pnpm verify` and CI.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWLIST } from "./page-service-role-allowlist.mjs";

const APP_ROOT = fileURLToPath(new URL("../apps/main/src/app", import.meta.url));

const USES_SERVICE_ROLE = /\bcreateServiceRoleClient\b/;
const IS_CLIENT_COMPONENT = /^\s*["']use client["']/m;

const offenders = [];
let scanned = 0;

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
      continue;
    }
    if (entry.name !== "page.tsx" && entry.name !== "page.ts") continue;

    scanned++;
    const src = readFileSync(p, "utf8");

    // Client components don't run on the server — no server-side data access.
    if (IS_CLIENT_COMPONENT.test(src)) continue;

    if (!USES_SERVICE_ROLE.test(src)) continue;

    const rel = relative(APP_ROOT, p);

    // (admin)/ prefix means the AdminLayout's assertPlatformAdmin gate applies.
    if (rel.startsWith("(admin)/")) continue;

    // Outside (admin) — must be in the allowlist.
    if (!ALLOWLIST.has(rel)) {
      offenders.push(rel);
    }
  }
}

walk(APP_ROOT);

if (offenders.length > 0) {
  console.error(
    `\n❌  ${offenders.length} server-component page(s) call createServiceRoleClient ` +
      `outside the (admin) route group without an allowlist entry:\n` +
      offenders.map((f) => `   ${f}`).join("\n") +
      `\n\nEither move the page into (admin)/ (and let AdminLayout gate it) ` +
      `or add an entry to the ALLOWLIST in scripts/check-page-service-role.mjs ` +
      `with an explicit justification for why the page is safe without an admin credential.\n`,
  );
  process.exit(1);
}

console.log(
  `✔ page-service-role: ${scanned} page(s) scanned, ` +
    `${ALLOWLIST.size} allowlisted, ${offenders.length} ungated.`,
);
