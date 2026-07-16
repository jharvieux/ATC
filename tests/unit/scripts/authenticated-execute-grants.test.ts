// Pins that the `authenticated` role retains EXECUTE on the three RLS helper
// functions (#1922). WHY this matters, not just what: these helpers
//   - public.auth_user_in_tenant(uuid)
//   - public.tenant_is_active(uuid)
//   - public.auth_user_can_access_conversation(uuid, uuid)
// are invoked from inside RLS policy bodies, which evaluate as the CALLING role
// (`authenticated`), not as the definer. If a future migration revokes the
// EXECUTE grant, every policy that calls the helper fails with
// `permission denied for function` — which reads as a generic access error and
// silently breaks tenant isolation for all signed-in users. Spec §5.1.1
// mandates the grant. This was proven empirically on the test DB during #1523,
// but that proof lived only in an issue comment; this test is the enforcement.
//
// The grants-snapshot diff does NOT cover this: db/grants-snapshot-main.sql
// captures TABLE DML grants only (SELECT/INSERT/UPDATE/DELETE), never function
// EXECUTE grants. So a REVOKE EXECUTE on these helpers would sail past that
// gate. This test closes that gap by replaying the migration ledger's
// GRANT/REVOKE EXECUTE statements and asserting the net final state.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.join(
  __dirname,
  "../../../apps/main/supabase/migrations",
);

const HELPER_FUNCTIONS = [
  "auth_user_in_tenant",
  "tenant_is_active",
  "auth_user_can_access_conversation",
] as const;

// Replays every GRANT/REVOKE EXECUTE statement targeting `funcName`, in order,
// and reports whether `authenticated` holds EXECUTE at the end. Roles are
// tracked separately because REVOKE ... FROM public (used by every helper right
// before the grant) does NOT strip a direct grant to `authenticated` — so a
// single boolean would misreport. authenticated holds EXECUTE if it has a
// direct grant OR PUBLIC still holds one.
function authenticatedHoldsExecute(sql: string, funcName: string): boolean {
  const stmtRe = new RegExp(
    String.raw`\b(GRANT|REVOKE)\s+(?:EXECUTE|ALL(?:\s+PRIVILEGES)?)\s+ON\s+FUNCTION\s+(?:public\.)?` +
      funcName +
      String.raw`\s*\([^)]*\)\s+(TO|FROM)\s+(\w+)`,
    "gi",
  );

  let directAuthGrant = false;
  let publicGrant = false;

  for (const m of sql.matchAll(stmtRe)) {
    const verb = m[1].toUpperCase();
    const role = m[3].toLowerCase();
    const granting = verb === "GRANT";
    if (role === "authenticated") directAuthGrant = granting;
    else if (role === "public") publicGrant = granting;
  }

  return directAuthGrant || publicGrant;
}

function readAllMigrations(): string {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n");
}

describe("authenticated retains EXECUTE on RLS helper functions (#1922)", () => {
  const ledger = readAllMigrations();

  for (const fn of HELPER_FUNCTIONS) {
    it(`authenticated holds EXECUTE on public.${fn} across the migration ledger`, () => {
      expect(authenticatedHoldsExecute(ledger, fn)).toBe(true);
    });
  }

  // Guard the guard: prove the analyzer actually trips when a future migration
  // revokes the grant. Uses an in-memory COPY of the real ledger with a REVOKE
  // appended — the real snapshot/migrations are never touched.
  for (const fn of HELPER_FUNCTIONS) {
    it(`fails loudly if a later migration REVOKEs EXECUTE on public.${fn} from authenticated`, () => {
      const poisoned =
        ledger +
        `\nREVOKE EXECUTE ON FUNCTION public.${fn}(uuid) FROM authenticated;\n`;
      expect(authenticatedHoldsExecute(poisoned, fn)).toBe(false);
    });
  }

  it("REVOKE ... FROM public (the pre-grant pattern every helper uses) does NOT count as revoking authenticated", () => {
    // Every helper migration does `REVOKE EXECUTE ... FROM public` immediately
    // before `GRANT EXECUTE ... TO authenticated`. If the analyzer treated the
    // FROM public revoke as stripping authenticated, this whole pin would be a
    // false negative. This pins that the two roles stay independent.
    const sql = [
      "REVOKE EXECUTE ON FUNCTION public.tenant_is_active(uuid) FROM public;",
      "GRANT  EXECUTE ON FUNCTION public.tenant_is_active(uuid) TO authenticated;",
    ].join("\n");
    expect(authenticatedHoldsExecute(sql, "tenant_is_active")).toBe(true);
  });
});
