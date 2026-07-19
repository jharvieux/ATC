// Unit tests — RLS policy-semantics guard (Harvey Tier-1 port, refs #2006).
// Intent: each sub-check must catch its finding class (wrong-column policy,
// USING(true) on a tenant table, uncalled-checked DEFINER write, #2006-style
// DEFINER read oracle, bare auth.* initplan miss) WITHOUT flagging the correct
// counterpart shape — otherwise the gate is either blind or noise.
import { describe, it, expect } from "vitest";
import {
  parsePolicies,
  parseDefinerFunctions,
  reviewPolicy,
  inferTenancyModel,
  needsAuthzReview,
  isDefinerOracle,
  bareInitplanCalls,
  scanMigrationSet,
  loadBaseline,
} from "../../../scripts/check-rls-policy-semantics";

const TENANT_TABLE_SQL = `
create table public.notes (
  id uuid primary key,
  tenant_id uuid not null,
  body text
);
`;

describe("parsePolicies", () => {
  it("extracts cmd, USING, and WITH CHECK bodies", () => {
    const { policies, unparsed } = parsePolicies(
      `create policy notes_sel on public.notes for select using (tenant_id = current_tenant_id());`,
    );
    expect(unparsed).toEqual([]);
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({ table: "notes", cmd: "SELECT", qual: "tenant_id = current_tenant_id()", withCheck: null });
  });

  it("fails loud on an unterminated statement instead of dropping the policy", () => {
    const { policies, unparsed } = parsePolicies(`create policy broken on public.notes for select using (true)`);
    expect(policies).toEqual([]);
    expect(unparsed).toHaveLength(1);
  });
});

describe("reviewPolicy — per-tenant model", () => {
  const model = { tenantKey: "tenant_id" };

  it("flags a policy keyed on caller identity without the tenant key (#206 wrong-column class)", () => {
    const p = parsePolicies(`create policy p on public.notes for select using (user_id = auth.uid());`).policies[0]!;
    expect(reviewPolicy(p, model)).toMatch(/never references the tenant key/);
  });

  it("flags USING (true) on a tenant-key table", () => {
    const p = parsePolicies(`create policy p on public.notes for select using (true);`).policies[0]!;
    expect(reviewPolicy(p, model)).toMatch(/USING is "true"/);
  });

  it("flags a disguised tautology (col IS NULL OR col IS NOT NULL)", () => {
    const p = parsePolicies(`create policy p on public.notes for select using (body is null or body is not null);`).policies[0]!;
    expect(reviewPolicy(p, model)).toMatch(/USING is "true"/);
  });

  it("flags WITH CHECK weaker than a tenant-scoped USING", () => {
    const p = parsePolicies(
      `create policy p on public.notes for update using (tenant_id = current_tenant_id()) with check (body <> '');`,
    ).policies[0]!;
    expect(reviewPolicy(p, model)).toMatch(/WITH CHECK does not/);
  });

  it("clears a correctly tenant-scoped policy", () => {
    const p = parsePolicies(
      `create policy p on public.notes for update using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());`,
    ).policies[0]!;
    expect(reviewPolicy(p, model)).toBeNull();
  });
});

describe("reviewPolicy — per-user model", () => {
  const model = { tenantKey: "", mode: "per-user" as const };

  it("clears an own-row policy bound to auth.uid()", () => {
    const p = parsePolicies(`create policy p on public.profiles for select using (id = auth.uid());`).policies[0]!;
    expect(reviewPolicy(p, model)).toBeNull();
  });

  it("flags an indirect caller reference with no owner binding", () => {
    const p = parsePolicies(`create policy p on public.profiles for select using (current_setting('app.user') = 'x');`).policies[0]!;
    expect(reviewPolicy(p, model)).toMatch(/never binds a row column to auth\.uid\(\)/);
  });
});

describe("inferTenancyModel", () => {
  it("infers per-tenant from a declared tenant_id column", () => {
    expect(inferTenancyModel(TENANT_TABLE_SQL, "notes")).toEqual({ tenantKey: "tenant_id" });
  });

  it("falls back to per-user for a table with no recognised tenant column", () => {
    expect(inferTenancyModel(`create table public.profiles (\n id uuid\n);`, "profiles").mode).toBe("per-user");
  });
});

describe("definer checks (D-091 #27)", () => {
  const definer = (body: string, args = "target_id uuid") =>
    parseDefinerFunctions(
      `create or replace function public.f(${args}) returns boolean language plpgsql security definer as $$ ${body} $$;`,
    )[0]!;

  it("needsAuthzReview flags a privileged write with no caller check", () => {
    expect(needsAuthzReview(definer(`begin update profiles set role = 'admin' where id = target_id; end`))).toBe(true);
  });

  it("needsAuthzReview clears a write that consults auth.uid()", () => {
    expect(needsAuthzReview(definer(`begin if auth.uid() = target_id then update profiles set x = 1; end if; end`))).toBe(false);
  });

  it("isDefinerOracle flags the #2006 shape: parameter-only reader with no caller check", () => {
    expect(isDefinerOracle(definer(`begin return exists(select 1 from tenants where id = target_id and status = 'active'); end`))).toBe(true);
  });

  it("isDefinerOracle clears a zero-arg reader (nothing to enumerate)", () => {
    expect(isDefinerOracle(definer(`begin return exists(select 1 from tenants); end`, ""))).toBe(false);
  });

  it("isDefinerOracle clears a reader that consults the caller", () => {
    expect(isDefinerOracle(definer(`begin return exists(select 1 from tenants where id = target_id and owner = auth.uid()); end`))).toBe(false);
  });
});

describe("bareInitplanCalls", () => {
  it("flags a bare auth.uid() and a bare current_setting()", () => {
    const p = parsePolicies(
      `create policy p on public.notes for select using (tenant_id::text = current_setting('app.tenant') and user_id = auth.uid());`,
    ).policies[0]!;
    expect(bareInitplanCalls(p)).toHaveLength(2);
  });

  it("clears (select auth.uid())-wrapped calls", () => {
    const p = parsePolicies(`create policy p on public.notes for select using (user_id = (select auth.uid()));`).policies[0]!;
    expect(bareInitplanCalls(p)).toEqual([]);
  });
});

describe("scanMigrationSet", () => {
  it("keys findings line-independently so file edits don't churn the baseline", () => {
    const findings = scanMigrationSet([
      { file: "apps/main/supabase/migrations/1.sql", sql: `${TENANT_TABLE_SQL}\ncreate policy p on public.notes for select using (true);` },
    ]);
    expect(findings.map((f) => f.key)).toContain("policy-semantics::public.notes.p");
  });
});

describe("loadBaseline", () => {
  it("returns an empty map for a missing file (fail-closed: every live finding is fresh)", () => {
    expect(loadBaseline("/nonexistent/rls-baseline-2006.txt")).toEqual(new Map());
  });
});
