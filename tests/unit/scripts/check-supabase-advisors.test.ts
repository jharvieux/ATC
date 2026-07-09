// #1635 — unit tests for the Supabase advisor finding filter.
//
// Pins the three decisions that matter: WARN+ fires, baselined findings are
// suppressed, INFO is below threshold, and the baseline is project-scoped so a
// key accepted for one project doesn't silence the same lint on another.

import { describe, it, expect } from "vitest";
import { newFindings, type Lint } from "../../../scripts/check-supabase-advisors";

const FAIL = ["WARN", "ERROR"];

function lint(overrides: Partial<Lint> & { cache_key: string; level: string }): Lint {
  return { name: "some_lint", ...overrides };
}

const leaked = lint({ name: "auth_leaked_password_protection", level: "WARN", cache_key: "auth_leaked_password_protection" });
const definer = lint({ name: "authenticated_security_definer_function_executable", level: "WARN", cache_key: "def_public_helper" });
const rlsInfo = lint({ name: "rls_enabled_no_policy", level: "INFO", cache_key: "rls_enabled_no_policy_public_x" });

describe("newFindings", () => {
  it("returns a WARN finding not in the baseline (the leaked-password case)", () => {
    expect(newFindings("atc-main", [leaked], new Set(), FAIL)).toEqual([leaked]);
  });

  it("suppresses a WARN finding that is baselined", () => {
    const base = new Set(["atc-main:def_public_helper"]);
    expect(newFindings("atc-main", [definer], base, FAIL)).toEqual([]);
  });

  it("ignores INFO-level lints (below the fail threshold)", () => {
    expect(newFindings("atc-main", [rlsInfo], new Set(), FAIL)).toEqual([]);
  });

  it("is project-scoped — a key baselined for atc-rag does not silence atc-main", () => {
    const base = new Set(["atc-rag:def_public_helper"]);
    expect(newFindings("atc-main", [definer], base, FAIL)).toEqual([definer]);
  });

  it("treats ERROR as failing too", () => {
    const err = lint({ name: "x", level: "ERROR", cache_key: "boom" });
    expect(newFindings("atc-main", [err], new Set(), FAIL)).toEqual([err]);
  });
});
