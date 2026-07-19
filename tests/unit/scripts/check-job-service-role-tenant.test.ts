// Unit tests — background-job service-role tenant-predicate guard (refs #2003).
// Intent: the d091 detector exempts rls-exception "platform" tables — but a
// platform-exempted table that carries tenant_id has app-layer predicates as
// its ONLY isolation layer, and a filtered job read without one is the #2003
// gmail_inbound_messages bug. Deliberate cross-tenant sweeps (no row filter)
// and annotated sites must stay silent.
import { describe, it, expect } from "vitest";
import { tenantBearingTables, findUnscopedJobReads, loadBaseline } from "../../../scripts/check-job-service-role-tenant";

describe("tenantBearingTables", () => {
  it("derives tables with an inline tenant_id column", () => {
    const sql = `create table public.gmail_inbound_messages (\n  id uuid primary key,\n  tenant_id uuid not null,\n  body_text text\n);`;
    expect(tenantBearingTables(sql)).toEqual(new Set(["gmail_inbound_messages"]));
  });

  it("derives tables that gain tenant_id via ALTER ADD COLUMN", () => {
    const sql = `create table public.email_log (\n  id uuid primary key\n);\nalter table public.email_log add column tenant_id uuid;`;
    expect(tenantBearingTables(sql)).toContain("email_log");
  });

  it("ignores commented-out DDL", () => {
    expect(tenantBearingTables(`-- create table public.ghost (\n--   tenant_id uuid\n-- );`)).toEqual(new Set());
  });
});

describe("findUnscopedJobReads", () => {
  const TABLES = new Set(["gmail_inbound_messages"]);
  const F = "apps/main/src/inngest/import-pipeline.ts";
  const job = (query: string) => `
import { createServiceRoleClient } from "@/lib/db/service-role-client";
export async function run() {
  const svc = createServiceRoleClient();
  ${query}
}
`;

  it("flags the #2003 shape: filtered read of a tenant_id-bearing table, no tenant predicate", () => {
    const r = findUnscopedJobReads(F, job(`const { data } = await svc\n    .from("gmail_inbound_messages")\n    .select("body_text")\n    .eq("message_id", ref)\n    .maybeSingle();`), TABLES);
    expect(r).toHaveLength(1);
    expect(r[0]!.key).toBe(`${F}::gmail_inbound_messages`);
  });

  it("clears the same read once it carries .eq(\"tenant_id\", …)", () => {
    const r = findUnscopedJobReads(F, job(`const { data } = await svc\n    .from("gmail_inbound_messages")\n    .select("body_text")\n    .eq("tenant_id", tenantId)\n    .eq("message_id", ref);`), TABLES);
    expect(r).toEqual([]);
  });

  it("clears a deliberate cross-tenant sweep (no row filter at all)", () => {
    const r = findUnscopedJobReads(F, job(`const { data } = await svc.from("gmail_inbound_messages").select("id").limit(100);`), TABLES);
    expect(r).toEqual([]);
  });

  it("clears a site annotated d091-allow:service-role-tenant", () => {
    const r = findUnscopedJobReads(
      F,
      job(`// d091-allow:service-role-tenant reviewed — message_id is globally unique\n  const { data } = await svc.from("gmail_inbound_messages").select("body_text").eq("message_id", ref);`),
      TABLES,
    );
    expect(r).toEqual([]);
  });

  it("ignores unwatched tables and files without service-role usage", () => {
    expect(findUnscopedJobReads(F, job(`await svc.from("other_table").select("id").eq("id", x);`), TABLES)).toEqual([]);
    expect(
      findUnscopedJobReads(F, `export async function run(db) { await db.from("gmail_inbound_messages").select("id").eq("id", x); }`, TABLES),
    ).toEqual([]);
  });
});

describe("loadBaseline", () => {
  it("returns an empty map for a missing file (fail-closed)", () => {
    expect(loadBaseline("/nonexistent/job-sr-baseline-2003.txt")).toEqual(new Map());
  });
});
