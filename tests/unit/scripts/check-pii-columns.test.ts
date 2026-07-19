// Unit tests — PII column-classification guard (Harvey Tier-1 port, refs #2011).
// The classifier's own 43-case acceptance suite runs via
// `node scripts/check-pii-columns.mjs --selftest`; these tests cover the
// guard-specific pieces: the static live-column parse (drop/re-create aware)
// and the classifications the ATC schema depends on.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module, no type declarations
import { classifyColumn, parseLiveColumns } from "../../../scripts/check-pii-columns.mjs";

describe("parseLiveColumns", () => {
  it("extracts columns with their SQL types", () => {
    const cols = parseLiveColumns(`create table public.users (\n  id uuid primary key,\n  email text not null\n);`);
    expect(cols).toEqual([
      { table_name: "users", column_name: "id", data_type: "uuid" },
      { table_name: "users", column_name: "email", data_type: "text" },
    ]);
  });

  it("uses the EFFECTIVE definition after a drop/re-create (the email_log shape)", () => {
    const sql = `
create table public.email_log (
  id uuid primary key,
  recipient_email text
);
drop table public.email_log;
create table public.email_log (
  id uuid primary key,
  to_email text
);`;
    const names = parseLiveColumns(sql).map((c: { column_name: string }) => c.column_name);
    expect(names).toContain("to_email");
    expect(names).not.toContain("recipient_email");
  });

  it("includes PII columns added later via ALTER ADD COLUMN", () => {
    const sql = `create table public.contacts (\n  id uuid primary key\n);\nalter table public.contacts add column phone_number text;`;
    expect(parseLiveColumns(sql).map((c: { column_name: string }) => c.column_name)).toContain("phone_number");
  });
});

describe("classifyColumn — guard-critical classes", () => {
  it("classifies a new PII column (the class the guard blocks unbaselined)", () => {
    expect(classifyColumn("passport_number", "text", "travelers")).toMatchObject({ category: "SENSITIVE_PII" });
  });

  it("flags a JSONB denormalization container at low confidence (refs #2011)", () => {
    expect(classifyColumn("metadata", "jsonb", "bookings")).toMatchObject({ infotype: "OPAQUE_JSON_BLOB", confidence: "low" });
  });

  it("stays silent on non-PII plumbing columns", () => {
    expect(classifyColumn("tenant_id", "uuid", "bookings")).toBeNull();
    expect(classifyColumn("created_at", "timestamptz", "bookings")).toBeNull();
  });
});
