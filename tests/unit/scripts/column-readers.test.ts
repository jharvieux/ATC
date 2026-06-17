// The static-column reader gate exists because tsc cannot catch references to
// columns that NEVER EXISTED on a table — Supabase JS column names are plain
// strings. Issue #1183 (tenants.tier, a FK that was always tier_id) is the
// canonical incident: the personas PATCH route read .tier while the schema had
// only .tier_id, and nothing caught it until runtime.
//
// These tests pin the gate behavior in BOTH directions:
//   - Real violations MUST be flagged (the #1183 failure shape)
//   - Legitimate look-alikes MUST NOT trigger false positives:
//       views / unknown tables, wildcard selects, embedded resources,
//       JSON operators, next-table windows, exceptions file silencing

import { describe, it, expect } from "vitest";
import {
  computeLiveColumns,
  parseSelectColumns,
  findSelectViolations,
  parseExceptions,
  type Migration,
  type SourceFile,
} from "../../../scripts/lib/column-readers";

const mig = (content: string, file = "001.sql"): Migration => ({ file, content });
const src = (content: string, file = "reader.ts"): SourceFile => ({ file, content });

// ─── computeLiveColumns ────────────────────────────────────────────────────

describe("computeLiveColumns", () => {
  it("seeds columns from CREATE TABLE — skips CONSTRAINT/PRIMARY/UNIQUE/CHECK/FOREIGN keywords", () => {
    const live = computeLiveColumns([
      mig(`CREATE TABLE public.tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        legal_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'onboarding',
        tier_id UUID REFERENCES public.tier_definitions(id),
        CONSTRAINT tenants_status_check CHECK (status IN ('onboarding','active')),
        UNIQUE (legal_name)
      );`),
    ]);
    const cols = live.get("tenants")!;
    expect(cols).toContain("id");
    expect(cols).toContain("legal_name");
    expect(cols).toContain("status");
    expect(cols).toContain("tier_id");
    // Constraint/index keywords must not be treated as column names
    expect(cols).not.toContain("constraint");
    expect(cols).not.toContain("primary");
    expect(cols).not.toContain("unique");
    expect(cols).not.toContain("check");
  });

  it("ADD COLUMN extends the live set for an existing table", () => {
    const live = computeLiveColumns([
      mig(`CREATE TABLE public.tenants (id UUID PRIMARY KEY);`, "001.sql"),
      mig(`ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS ai_paused_by_platform BOOLEAN NOT NULL DEFAULT FALSE;`, "002.sql"),
    ]);
    expect(live.get("tenants")).toContain("ai_paused_by_platform");
  });

  it("DROP COLUMN removes the column from the live set (gate must catch reads after the drop)", () => {
    const live = computeLiveColumns([
      mig(`CREATE TABLE public.tenants (id UUID PRIMARY KEY, tier TEXT);`, "001.sql"),
      mig(`ALTER TABLE public.tenants DROP COLUMN IF EXISTS tier;`, "002.sql"),
    ]);
    // tier was removed — a .select("tier") from tenants is a violation
    expect(live.get("tenants")).not.toContain("tier");
    expect(live.get("tenants")).toContain("id");
  });

  it("RENAME COLUMN removes the old name and adds the new name — reads of the old name must fail", () => {
    const live = computeLiveColumns([
      mig(`CREATE TABLE public.quotes (id UUID PRIMARY KEY, cruise_line TEXT);`, "001.sql"),
      mig(`ALTER TABLE public.quotes RENAME COLUMN cruise_line TO cruise_line_id;`, "002.sql"),
    ]);
    const cols = live.get("quotes")!;
    expect(cols).not.toContain("cruise_line");
    expect(cols).toContain("cruise_line_id");
  });

  it("processes migrations in filename order — a DROP in file 003 reverses an ADD in file 002", () => {
    const live = computeLiveColumns([
      mig(`CREATE TABLE public.bookings (id UUID PRIMARY KEY);`, "001.sql"),
      mig(`ALTER TABLE public.bookings ADD COLUMN legacy_ref TEXT;`, "002.sql"),
      mig(`ALTER TABLE public.bookings DROP COLUMN IF EXISTS legacy_ref;`, "003.sql"),
    ]);
    expect(live.get("bookings")).not.toContain("legacy_ref");
  });

  it("the #1183 incident shape: tenants has tier_id but NOT tier — gate would have caught it", () => {
    const live = computeLiveColumns([
      mig(`CREATE TABLE public.tenants (
        id UUID PRIMARY KEY,
        tier_id UUID REFERENCES public.tier_definitions(id)
      );`),
    ]);
    const cols = live.get("tenants")!;
    expect(cols).toContain("tier_id");
    expect(cols).not.toContain("tier");
  });
});

// ─── parseSelectColumns ────────────────────────────────────────────────────

describe("parseSelectColumns", () => {
  it("returns bare column names from a simple comma-separated select string", () => {
    expect(parseSelectColumns("id, legal_name, status")).toEqual(["id", "legal_name", "status"]);
  });

  it("skips the wildcard * — no checkable column names", () => {
    expect(parseSelectColumns("*")).toEqual([]);
    expect(parseSelectColumns("id, *")).toEqual(["id"]);
  });

  it("skips embedded resources (tokens with parens) — they reference a related table's columns", () => {
    // .select("tier_definitions(code)") references tier_definitions.code, not tenants.code
    expect(parseSelectColumns("id, tier_definitions(code)")).toEqual(["id"]);
  });

  it("skips JSON operators -> — they reach into JSONB sub-fields, not top-level columns", () => {
    expect(parseSelectColumns("id, metadata->key")).toEqual(["id"]);
  });

  it("skips !inner / !left modifiers", () => {
    expect(parseSelectColumns("!inner, id")).toEqual(["id"]);
  });

  it("strips col:alias syntax — returns the base column name, not the alias", () => {
    // .select("id:uuid, legal_name:name") — the key to send to Postgres is the left side
    expect(parseSelectColumns("id:uuid, legal_name:name")).toEqual(["id", "legal_name"]);
  });
});

// ─── findSelectViolations ──────────────────────────────────────────────────

describe("findSelectViolations", () => {
  it("flags a column that is absent from the table's live set (#1183 incident shape)", () => {
    const live = new Map([["tenants", new Set(["id", "tier_id", "legal_name"])]]);
    const v = findSelectViolations(
      live,
      [src(`await db.from("tenants").select("id, tier, legal_name");`)],
    );
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ table: "tenants", column: "tier" });
  });

  it("does NOT flag a column that IS in the live set", () => {
    const live = new Map([["tenants", new Set(["id", "tier_id", "legal_name"])]]);
    const v = findSelectViolations(
      live,
      [src(`await db.from("tenants").select("id, tier_id, legal_name");`)],
    );
    expect(v).toHaveLength(0);
  });

  it("skips tables not in the live map (views, non-public schemas) — no false positives", () => {
    const live = new Map<string, Set<string>>(); // empty — no known tables
    const v = findSelectViolations(
      live,
      [src(`await db.from("some_view").select("id, computed_col");`)],
    );
    expect(v).toHaveLength(0);
  });

  it("is TABLE-AWARE: a column absent from tenants but present on bookings is not flagged on bookings reads", () => {
    const live = new Map([
      ["tenants", new Set(["id", "legal_name"])],
      ["bookings", new Set(["id", "ai_paused_by_platform"])],
    ]);
    // ai_paused_by_platform is NOT on tenants — a tenants read would fail;
    // but on the bookings read it is live and must not be flagged.
    const v = findSelectViolations(
      live,
      [src(`await db.from("bookings").select("id, ai_paused_by_platform");`)],
    );
    expect(v).toHaveLength(0);
  });

  it("window ends at the next .from() call — column names in the next query are NOT misattributed", () => {
    const live = new Map([
      ["tenants", new Set(["id", "legal_name"])],
      ["bookings", new Set(["id", "customer_name"])],
    ]);
    const content = [
      `await db.from("tenants").select("id, legal_name");`,
      `await db.from("bookings").select("id, customer_name");`,
    ].join(" ");
    // customer_name is not on tenants — but it belongs to the bookings window, not tenants.
    const v = findSelectViolations(live, [src(content)]);
    expect(v).toHaveLength(0);
  });

  it("skips embedded resources inside .select() — the gate does not resolve related-table columns", () => {
    const live = new Map([["tenants", new Set(["id", "tier_id"])]]);
    // tier_definitions(code) is an embedded resource — it references tier_definitions.code,
    // not tenants.code. The gate must not flag "code" against the tenants live set.
    const v = findSelectViolations(
      live,
      [src(`await db.from("tenants").select("id, tier_id, tier_definitions(code)");`)],
    );
    expect(v).toHaveLength(0);
  });
});

// ─── parseExceptions ────────────────────────────────────────────────────────

describe("parseExceptions", () => {
  it("honors `table.column # reason` entries and lowercases the key", () => {
    expect(parseExceptions("Tenants.Tier # pre-existing violation — tracked in #1190\n")).toEqual(
      new Set(["tenants.tier"]),
    );
  });

  it("ignores entries with no reason (requires explicit documentation)", () => {
    expect(parseExceptions("tenants.tier\n")).toEqual(new Set());
  });

  it("ignores comment lines starting with #", () => {
    expect(parseExceptions("# header\ntenants.tier # reason")).toEqual(new Set(["tenants.tier"]));
  });
});
