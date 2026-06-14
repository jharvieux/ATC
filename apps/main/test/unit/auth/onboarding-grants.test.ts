// §15 / §26.2 — Onboarding RBAC grant-coverage guard.
//
// WHY this test exists: when assertPermission's RBAC stub was replaced with
// real enforcement (2026-05-25, Finding 5), the onboarding wizard routes were
// gated on (resource:"onboarding", action:"<step>") pairs but only the
// profile:* grants were added to the matrix. Every other step — legal, ica,
// tier, etc. — 403'd, silently breaking every new-agency signup at the legal
// step until a real operator walked the full flow.
//
// This test reads the action strings straight out of the route handlers and
// asserts tenant_owner (the role a signing-up operator is provisioned as) is
// granted each one. It fails the moment a new onboarding route is added with a
// gate but no matching grant — turning a prod 403 into a CI failure.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isPermitted } from "@/lib/auth/permission-grants";

const ONBOARDING_API_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/app/api/onboarding",
);

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === "route.ts" ? [full] : [];
  });
}

// Pull every (resource:"onboarding", action:"x") pair out of a route file.
// Matches the assertPermission call shape regardless of intervening whitespace.
function onboardingActions(source: string): string[] {
  const re =
    /resource:\s*"onboarding"\s*,\s*action:\s*"([^"]+)"/g;
  const found: string[] = [];
  for (const m of source.matchAll(re)) found.push(m[1]!);
  return found;
}

const actions = [
  ...new Set(
    routeFiles(ONBOARDING_API_DIR).flatMap((f) =>
      onboardingActions(readFileSync(f, "utf8")),
    ),
  ),
].sort();

describe("onboarding RBAC grant coverage", () => {
  it("discovers the gated onboarding actions from the route handlers", () => {
    // Sanity guard: if this is empty, the regex or path drifted and the rest
    // of the suite would pass vacuously.
    expect(actions.length).toBeGreaterThanOrEqual(10);
  });

  it.each(actions)(
    'tenant_owner is granted onboarding:%s',
    (action) => {
      expect(isPermitted("tenant_owner", "onboarding", action)).toBe(true);
    },
  );
});
