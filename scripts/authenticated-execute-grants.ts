// Static analyzer that pins `authenticated` keeps EXECUTE on the three RLS
// helper functions (#1922):
//   - public.auth_user_in_tenant(uuid)
//   - public.tenant_is_active(uuid)
//   - public.auth_user_can_access_conversation(uuid, uuid)
//
// WHY this matters, not just what: these helpers are invoked from inside RLS
// policy bodies, which evaluate as the CALLING role (`authenticated`), not as
// the definer. If a future migration revokes the EXECUTE grant, every policy
// that calls the helper fails with `permission denied for function` — which
// reads as a generic access error and silently breaks tenant isolation for all
// signed-in users. Spec §5.1.1 mandates the grant. This was proven empirically
// on the test DB during #1523, but that proof lived only in an issue comment;
// this analyzer is the enforcement.
//
// The grants-snapshot diff does NOT cover this: db/grants-snapshot-main.sql
// captures TABLE DML grants only (SELECT/INSERT/UPDATE/DELETE), never function
// EXECUTE grants. So a REVOKE EXECUTE on these helpers would sail past that
// gate. This closes the gap by replaying the migration ledger's GRANT/REVOKE
// EXECUTE statements and asserting the net final state.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = path.join(
  MODULE_DIR,
  "../apps/main/supabase/migrations",
);

export const HELPER_FUNCTIONS = [
  "auth_user_in_tenant",
  "tenant_is_active",
  "auth_user_can_access_conversation",
] as const;

// Concatenates every migration file in sorted (== apply) order. Sequence is
// meaningful: a later statement's effect overrides an earlier one, and a DROP
// resets grants (see authenticatedHoldsExecute).
export function readAllMigrations(dir: string = MIGRATIONS_DIR): string {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

function rolesInList(list: string): string[] {
  return list
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
}

// Replays every DROP / GRANT / REVOKE EXECUTE statement targeting `funcName`, in
// ledger order, and reports whether `authenticated` holds EXECUTE at the end.
//
// Roles are tracked separately (see module header rationale) because REVOKE ...
// FROM public (used by every helper right before the grant) does NOT strip a
// direct grant to `authenticated`. authenticated holds EXECUTE if it has a
// direct grant OR PUBLIC still holds one.
//
// Three subtleties this handles:
//  - multi-role lists: `... FROM anon, authenticated;` revokes BOTH — the role
//    list is captured whole and split, so authenticated isn't invisible when
//    listed second.
//  - DROP resets grants: a DROP FUNCTION drops all its privileges, so grants
//    before the drop don't survive it. On DROP we reset tracked state to false;
//    only grants appearing AFTER the drop count. (Modeled for these three names
//    only — a full catalog state-machine would be disproportionate. Resetting
//    to false is conservative: if a future DROP+CREATE relies on the implicit
//    PUBLIC default without an explicit re-grant, we flag it false, which is the
//    fail-loud outcome we want for an RLS helper.)
export function authenticatedHoldsExecute(sql: string, funcName: string): boolean {
  const re = new RegExp(
    String.raw`\bDROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?` +
      funcName +
      String.raw`\b` +
      `|` +
      String.raw`\b(GRANT|REVOKE)\s+(?:EXECUTE|ALL(?:\s+PRIVILEGES)?)\s+ON\s+FUNCTION\s+(?:public\.)?` +
      funcName +
      String.raw`\s*\([^)]*\)\s+(TO|FROM)\s+([\w\s,]+?)\s*;`,
    "gi",
  );

  let directAuthGrant = false;
  let publicGrant = false;

  for (const m of sql.matchAll(re)) {
    if (m[1] === undefined) {
      // DROP branch (no capture groups) — grants don't survive the drop.
      directAuthGrant = false;
      publicGrant = false;
      continue;
    }
    const granting = m[1].toUpperCase() === "GRANT";
    for (const role of rolesInList(m[3])) {
      if (role === "authenticated") directAuthGrant = granting;
      else if (role === "public") publicGrant = granting;
    }
  }

  return directAuthGrant || publicGrant;
}

// A schema-wide bulk revoke (`REVOKE ... ON ALL FUNCTIONS IN SCHEMA public FROM
// authenticated;`) can't be resolved per-function by the replay above — it hits
// every function at once and there's no argument signature to key on. If such a
// statement targets `authenticated` or `public`, treat it as an automatic red
// so a human reviews, rather than silently missing it. Returns true if any such
// statement is present in the ledger.
export function schemaWideExecuteRevokeHitsAuthenticated(sql: string): boolean {
  const re =
    /\bREVOKE\s+(?:EXECUTE|ALL(?:\s+PRIVILEGES)?)\s+ON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\s+public\s+FROM\s+([\w\s,]+?)\s*;/gi;
  for (const m of sql.matchAll(re)) {
    const roles = rolesInList(m[1]);
    if (roles.includes("authenticated") || roles.includes("public")) return true;
  }
  return false;
}
