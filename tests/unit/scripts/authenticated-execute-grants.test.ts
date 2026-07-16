// Pins that the `authenticated` role retains EXECUTE on the three RLS helper
// functions (#1922). The analyzer, the WHY, and the fail-loud rationale live in
// scripts/authenticated-execute-grants.ts — this file exercises it against the
// real migration ledger plus adversarial trip-cases.

import { describe, it, expect } from "vitest";
import {
  HELPER_FUNCTIONS,
  readAllMigrations,
  authenticatedHoldsExecute,
  schemaWideExecuteRevokeHitsAuthenticated,
} from "../../../scripts/authenticated-execute-grants";

describe("authenticated retains EXECUTE on RLS helper functions (#1922)", () => {
  const ledger = readAllMigrations();

  for (const fn of HELPER_FUNCTIONS) {
    it(`authenticated holds EXECUTE on public.${fn} across the migration ledger`, () => {
      expect(authenticatedHoldsExecute(ledger, fn)).toBe(true);
    });
  }

  it("no schema-wide REVOKE ON ALL FUNCTIONS strips authenticated/public in the real ledger", () => {
    // This form can't be resolved per-function, so its mere presence is an
    // automatic red the analyzer must surface. The real ledger has none.
    expect(schemaWideExecuteRevokeHitsAuthenticated(ledger)).toBe(false);
  });

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

  it("trips on a multi-role REVOKE where authenticated is listed SECOND (list-bypass regression)", () => {
    // BLOCKER fix: a single-role capture would inspect only `anon` here and miss
    // authenticated's revoke entirely, reporting a false positive (still granted).
    const sql = [
      "REVOKE EXECUTE ON FUNCTION public.auth_user_in_tenant(uuid) FROM public;",
      "GRANT  EXECUTE ON FUNCTION public.auth_user_in_tenant(uuid) TO authenticated;",
      "REVOKE EXECUTE ON FUNCTION public.auth_user_in_tenant(uuid) FROM anon, authenticated;",
    ].join("\n");
    expect(authenticatedHoldsExecute(sql, "auth_user_in_tenant")).toBe(false);
  });

  it("flags a schema-wide REVOKE ON ALL FUNCTIONS FROM authenticated (invisible-bulk-revoke regression)", () => {
    // BLOCKER fix: this bulk form matched nothing in the per-function replay, so
    // a real revoke could sail through. It must now flip the schema-wide check.
    const sql =
      "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;";
    expect(schemaWideExecuteRevokeHitsAuthenticated(sql)).toBe(true);
  });

  it("reports false after DROP + CREATE + REVOKE FROM public with no re-grant (DROP resets grants)", () => {
    // WARNING fix: a prior GRANT to authenticated does NOT survive a DROP of the
    // function. If the analyzer treated old grants as eternal, this sequence —
    // which leaves authenticated with no EXECUTE — would falsely report granted.
    const sql = [
      "REVOKE EXECUTE ON FUNCTION public.tenant_is_active(uuid) FROM public;",
      "GRANT  EXECUTE ON FUNCTION public.tenant_is_active(uuid) TO authenticated;",
      "DROP FUNCTION IF EXISTS public.tenant_is_active(uuid);",
      "CREATE FUNCTION public.tenant_is_active(target_tenant_id uuid) RETURNS boolean AS $$ SELECT true $$ LANGUAGE sql;",
      "REVOKE EXECUTE ON FUNCTION public.tenant_is_active(uuid) FROM public;",
    ].join("\n");
    expect(authenticatedHoldsExecute(sql, "tenant_is_active")).toBe(false);
  });
});
