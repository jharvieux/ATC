// #562 — Static guard: server-component pages using createServiceRoleClient
// must be inside (admin)/ or in the explicit allowlist.
//
// This test is the intent-encoding complement to the script
// (scripts/check-page-service-role.mjs). The script runs in `pnpm verify`
// and CI; this test encodes WHY the check exists and what it protects against.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { ALLOWLIST } from "../../scripts/page-service-role-allowlist.mjs";

const APP_ROOT = fileURLToPath(
  new URL("../../apps/main/src/app", import.meta.url),
);

const USES_SERVICE_ROLE = /\bcreateServiceRoleClient\b/;
const IS_CLIENT_COMPONENT = /^\s*["']use client["']/m;

function collectPrivilegedPages(): string[] {
  const found: string[] = [];

  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { walk(p); continue; }
      if (entry.name !== "page.tsx" && entry.name !== "page.ts") continue;
      const src = readFileSync(p, "utf8");
      if (IS_CLIENT_COMPONENT.test(src)) continue;
      if (USES_SERVICE_ROLE.test(src)) found.push(relative(APP_ROOT, p));
    }
  }

  walk(APP_ROOT);
  return found;
}

describe("Page service-role guard (#562)", () => {
  const privileged = collectPrivilegedPages();

  it("every privileged page is either inside (admin)/ or in the allowlist", () => {
    // This is the #559 regression gate. A server component page that calls
    // createServiceRoleClient outside the (admin) layout gate can return
    // privileged data to an unauthenticated visitor — exactly the #559 vector.
    const ungated = privileged.filter(
      (rel) => !rel.startsWith("(admin)/") && !ALLOWLIST.has(rel),
    );
    expect(ungated, "ungated privileged pages (add to allowlist or move to (admin)/)").toEqual([]);
  });

  it("the (admin) layout enforces assertPlatformAdmin (the gate must not be removed)", () => {
    const layoutSrc = readFileSync(
      join(APP_ROOT, "(admin)", "layout.tsx"),
      "utf8",
    );
    expect(layoutSrc).toMatch(/assertPlatformAdmin/);
  });

  it("allowlisted token-gated pages call notFound() for invalid tokens", () => {
    // Token pages must fail-closed: if the token doesn't resolve a row,
    // notFound() must be called so the page returns 404, not 200 with empty state.
    for (const rel of ["companion/[token]/page.tsx", "i/[token]/page.tsx", "q/[token]/page.tsx"]) {
      const src = readFileSync(join(APP_ROOT, rel), "utf8");
      expect(src, `${rel} must call notFound()`).toMatch(/\bnotFound\(\)/);
    }
  });
});
