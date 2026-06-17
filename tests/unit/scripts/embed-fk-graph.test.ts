// Unit tests for the ambiguous-embed FK detection gate.
//
// The gate exists because PostgREST embeds that traverse one of several FK
// paths to the same referenced table are unpredictable — PostgREST picks
// arbitrarily. The `!inner` / `!left` modifiers choose JOIN TYPE, not which
// FK to follow; the fix is `!constraint_name`.
//
// Incident reference: issue #1134 — two FKs from contact_relationships to
// contacts (from_contact_id, to_contact_id) made embeds non-deterministic.
//
// These tests pin behavior in BOTH directions: the incident shape MUST flag,
// and unambiguous embeds / correctly-disambiguated embeds / join-type-only
// qualifiers must NOT flag.

import { describe, it, expect } from "vitest";
import {
  parseFKRelationships,
  buildAmbiguityMap,
  parseSelectEmbeds,
  findViolations,
  type Migration,
  type SourceFile,
} from "../../../scripts/lib/embed-fk-graph";

const mig = (content: string, file = "migration.sql"): Migration => ({ file, content });
const src = (content: string, file = "reader.ts"): SourceFile => ({ file, content });

// ────────────────────────────────────────────────────────────────────────────
// parseFKRelationships
// ────────────────────────────────────────────────────────────────────────────

describe("parseFKRelationships", () => {
  it("parses named CONSTRAINT within CREATE TABLE", () => {
    const fks = parseFKRelationships([
      mig(`CREATE TABLE public.commissions (
        id UUID PRIMARY KEY,
        booking_id UUID NOT NULL,
        CONSTRAINT commissions_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id)
      );`),
    ]);
    expect(fks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          constraintName: "commissions_booking_id_fkey",
          baseTable: "commissions",
          referencedTable: "bookings",
        }),
      ]),
    );
  });

  it("parses ADD CONSTRAINT in ALTER TABLE (named FK)", () => {
    const fks = parseFKRelationships([
      mig(`ALTER TABLE public.bookings
        ADD CONSTRAINT bookings_primary_contact_id_fkey
        FOREIGN KEY (primary_contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;`),
    ]);
    expect(fks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          constraintName: "bookings_primary_contact_id_fkey",
          baseTable: "bookings",
          referencedTable: "contacts",
        }),
      ]),
    );
  });

  it("parses inline REFERENCES in CREATE TABLE and derives constraint name", () => {
    // Inline: `col_name TYPE REFERENCES public.target(id)` →
    // constraint name convention: {table}_{col}_fkey
    const fks = parseFKRelationships([
      mig(`CREATE TABLE public.contact_relationships (
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        from_contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
        to_contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE
      );`),
    ]);
    const pairs = fks.map((f) => ({ base: f.baseTable, ref: f.referencedTable, name: f.constraintName }));
    // Two FKs to contacts
    const toContacts = pairs.filter((p) => p.base === "contact_relationships" && p.ref === "contacts");
    expect(toContacts).toHaveLength(2);
    expect(toContacts.map((p) => p.name)).toContain("contact_relationships_from_contact_id_fkey");
    expect(toContacts.map((p) => p.name)).toContain("contact_relationships_to_contact_id_fkey");
  });

  it("parses ADD FOREIGN KEY without CONSTRAINT keyword (anonymous)", () => {
    const fks = parseFKRelationships([
      mig(`ALTER TABLE public.conversations
        ADD FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;`),
    ]);
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({ baseTable: "conversations", referencedTable: "contacts" });
  });

  it("handles ALTER TABLE ONLY and IF EXISTS qualifiers", () => {
    const fks = parseFKRelationships([
      mig(`ALTER TABLE ONLY public.bookings
        ADD CONSTRAINT bookings_uid_fkey FOREIGN KEY (uid) REFERENCES public.users(id);`),
    ]);
    expect(fks[0]).toMatchObject({ baseTable: "bookings", referencedTable: "users" });
  });

  it("strips SQL comments and normalises whitespace before parsing", () => {
    const fks = parseFKRelationships([
      mig(`-- this is a comment
        CREATE TABLE public.items (
          id UUID PRIMARY KEY,
          /* block comment */
          user_id UUID REFERENCES public.users(id)
        );`),
    ]);
    expect(fks).toEqual(
      expect.arrayContaining([expect.objectContaining({ baseTable: "items", referencedTable: "users" })]),
    );
  });
});

  it("removes prior FKs when DROP TABLE is encountered (provisional-table pattern)", () => {
    // Migration 1: CREATE TABLE email_log with 1 FK to tenants (provisional)
    // Migration 2: DROP TABLE email_log; CREATE TABLE email_log with same 1 FK
    // Without DROP TABLE handling: 2 entries → false-positive ambiguity
    // With it: old entries purged → 1 entry → not ambiguous
    const fks = parseFKRelationships([
      mig(`CREATE TABLE public.email_log (
        tenant_id UUID NOT NULL REFERENCES public.tenants(id)
      );`, "m1.sql"),
      mig(`DROP TABLE IF EXISTS public.email_log;
        CREATE TABLE public.email_log (
          tenant_id UUID NOT NULL REFERENCES public.tenants(id)
        );`, "m2.sql"),
    ]);
    const toTenants = fks.filter((f) => f.baseTable === "email_log" && f.referencedTable === "tenants");
    expect(toTenants).toHaveLength(1);
  });

// ────────────────────────────────────────────────────────────────────────────
// buildAmbiguityMap
// ────────────────────────────────────────────────────────────────────────────

describe("buildAmbiguityMap", () => {
  it("marks a table pair as ambiguous when 2+ FKs exist", () => {
    const fks = parseFKRelationships([
      mig(`CREATE TABLE public.contact_relationships (
        from_contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
        to_contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE
      );`),
    ]);
    const map = buildAmbiguityMap(fks);
    const inner = map.get("contact_relationships");
    expect(inner?.get("contacts")).toHaveLength(2);
  });

  it("does NOT mark a table pair as ambiguous when only 1 FK exists", () => {
    const fks = parseFKRelationships([
      mig(`CREATE TABLE public.commissions (
        booking_id UUID REFERENCES public.bookings(id)
      );`),
    ]);
    const map = buildAmbiguityMap(fks);
    const inner = map.get("commissions");
    // bookings appears only once → not ambiguous
    expect(inner?.get("bookings")?.length ?? 0).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// parseSelectEmbeds
// ────────────────────────────────────────────────────────────────────────────

describe("parseSelectEmbeds", () => {
  it("extracts a plain embedded table", () => {
    const embeds = parseSelectEmbeds("contacts(id, name)");
    expect(embeds).toEqual([{ table: "contacts", hint: null }]);
  });

  it("extracts a table with !inner join modifier", () => {
    const embeds = parseSelectEmbeds("contacts!inner(id)");
    expect(embeds).toEqual([{ table: "contacts", hint: "inner" }]);
  });

  it("extracts a table with !left join modifier", () => {
    const embeds = parseSelectEmbeds("contacts!left(id)");
    expect(embeds).toEqual([{ table: "contacts", hint: "left" }]);
  });

  it("extracts a table with a real constraint-name hint", () => {
    const embeds = parseSelectEmbeds("contacts!contact_relationships_from_contact_id_fkey(id)");
    expect(embeds).toEqual([
      { table: "contacts", hint: "contact_relationships_from_contact_id_fkey" },
    ]);
  });

  it("handles multiple embeds in one select string", () => {
    const embeds = parseSelectEmbeds("tier_definitions!inner(code), bookings!fk_uid(id)");
    expect(embeds).toHaveLength(2);
    expect(embeds[0]).toEqual({ table: "tier_definitions", hint: "inner" });
    expect(embeds[1]).toEqual({ table: "bookings", hint: "fk_uid" });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// findViolations — the #1134 incident shape MUST flag
// ────────────────────────────────────────────────────────────────────────────

describe("findViolations", () => {
  // Build ambiguity map for the #1134 incident: contact_relationships → contacts (2 FKs)
  const incidentMig = mig(`CREATE TABLE public.contact_relationships (
    from_contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
    to_contact_id   UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE
  );`);
  const ambiguityMap = buildAmbiguityMap(parseFKRelationships([incidentMig]));

  it("flags an unqualified embed when 2 FK paths exist (#1134 incident shape)", () => {
    const violations = findViolations(
      ambiguityMap,
      [src(`.from("contact_relationships").select("contacts(id)")`)],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ baseTable: "contact_relationships", embeddedTable: "contacts" });
  });

  it("flags an !inner-qualified embed (join modifier ≠ disambiguation)", () => {
    const violations = findViolations(
      ambiguityMap,
      [src(`.from("contact_relationships").select("contacts!inner(id)")`)],
    );
    expect(violations).toHaveLength(1);
  });

  it("flags an !left-qualified embed (join modifier ≠ disambiguation)", () => {
    const violations = findViolations(
      ambiguityMap,
      [src(`.from("contact_relationships").select("contacts!left(id)")`)],
    );
    expect(violations).toHaveLength(1);
  });

  it("does NOT flag when a real constraint-name hint is provided", () => {
    const violations = findViolations(
      ambiguityMap,
      [src(`.from("contact_relationships").select("contacts!contact_relationships_from_contact_id_fkey(id)")`)],
    );
    expect(violations).toHaveLength(0);
  });

  it("does NOT flag an embed when only 1 FK path exists (unambiguous)", () => {
    // bookings → contacts has only 1 FK (primary_contact_id)
    const singleFkMig = mig(`ALTER TABLE public.bookings
      ADD CONSTRAINT bookings_primary_contact_id_fkey
      FOREIGN KEY (primary_contact_id) REFERENCES public.contacts(id);`);
    const singleMap = buildAmbiguityMap(parseFKRelationships([singleFkMig]));
    const violations = findViolations(
      singleMap,
      [src(`.from("bookings").select("contacts(id)")`)],
    );
    expect(violations).toHaveLength(0);
  });

  it("does NOT flag embeds in a different .from() chain (window isolation)", () => {
    // The contacts embed is in a bookings query, not contact_relationships
    const violations = findViolations(
      ambiguityMap,
      [src(`.from("bookings").select("contacts(id)").from("contact_relationships").select("id")`)],
    );
    // bookings → contacts is NOT in ambiguityMap (only contact_relationships is)
    expect(violations).toHaveLength(0);
  });

  it("returns file and line number in violation", () => {
    const violations = findViolations(
      ambiguityMap,
      [src(`const x = db\n  .from("contact_relationships")\n  .select("contacts(id)");`)],
    );
    expect(violations[0]).toMatchObject({ file: "reader.ts", line: expect.any(Number) });
    expect(violations[0].line).toBeGreaterThan(0);
  });

  it("reports the known FK constraint names in the violation", () => {
    const violations = findViolations(
      ambiguityMap,
      [src(`.from("contact_relationships").select("contacts(id)")`)],
    );
    expect(violations[0].knownConstraints).toHaveLength(2);
    expect(violations[0].knownConstraints).toContain(
      "contact_relationships_from_contact_id_fkey",
    );
    expect(violations[0].knownConstraints).toContain(
      "contact_relationships_to_contact_id_fkey",
    );
  });
});
