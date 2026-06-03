// The dropped-column-reader gate exists because Postgres column names reach the
// DB from application code only as STRINGS (`.from("quotes").select("cruise_line")`),
// so tsc cannot see that a migration dropped a column the code still asks for.
// That is exactly how BP38/#137 shipped: the §38 contract migration dropped the
// per-option trip/financial columns off `quotes` while readers still SELECTed
// them, and nothing failed until those readers 500'd in prod. These tests pin
// the gate's behavior in BOTH directions — the real incident shape MUST flag,
// and the legitimate look-alikes (a live same-named column on another table, a
// `_cents` superstring, a JS property access near an unrelated `.from`) MUST NOT
// — so a future refactor can't quietly re-open the #137 failure mode or bury
// every PR under false positives.

import { describe, it, expect } from "vitest";
import {
  parseColumnOps,
  computeRemovedColumns,
  findViolations,
  parseExceptions,
  type SourceFile,
} from "../../../scripts/lib/dropped-column-readers";

const src = (content: string, file = "reader.ts"): SourceFile => ({ file, content });

describe("parseColumnOps", () => {
  it("parses the real BP38 contract shape: ALTER TABLE public.<t> with multiple DROP COLUMN IF EXISTS", () => {
    const ops = parseColumnOps([
      {
        file: "contract.sql",
        content:
          "ALTER TABLE public.quotes DROP COLUMN IF EXISTS cruise_line, DROP COLUMN IF EXISTS ship_name, DROP COLUMN IF EXISTS total_amount;",
      },
    ]);
    expect(ops).toEqual([
      { table: "quotes", kind: "drop", column: "cruise_line" },
      { table: "quotes", kind: "drop", column: "ship_name" },
      { table: "quotes", kind: "drop", column: "total_amount" },
    ]);
  });

  it("treats RENAME COLUMN as a drop of the old name plus an add of the new", () => {
    const ops = parseColumnOps([
      { file: "1.sql", content: "ALTER TABLE quotes RENAME COLUMN old_name TO new_name;" },
    ]);
    expect(ops).toEqual([
      { table: "quotes", kind: "drop", column: "old_name" },
      { table: "quotes", kind: "add", column: "new_name" },
    ]);
  });

  it("survives SQL comments and the ONLY / IF EXISTS qualifiers", () => {
    const ops = parseColumnOps([
      {
        file: "2.sql",
        content:
          "-- drop the legacy col\nALTER TABLE ONLY public.bookings DROP COLUMN IF EXISTS legacy_field; /* done */",
      },
    ]);
    expect(ops).toEqual([{ table: "bookings", kind: "drop", column: "legacy_field" }]);
  });
});

describe("computeRemovedColumns", () => {
  it("returns columns dropped at migration HEAD, keyed by table", () => {
    const removed = computeRemovedColumns([
      { table: "quotes", kind: "drop", column: "cruise_line" },
      { table: "quotes", kind: "drop", column: "ship_name" },
    ]);
    expect(removed.get("quotes")).toEqual(new Set(["cruise_line", "ship_name"]));
  });

  it("excludes a drop-then-re-add (expand/contract on the same table leaves the column live)", () => {
    const removed = computeRemovedColumns([
      { table: "quotes", kind: "drop", column: "cruise_line" },
      { table: "quotes", kind: "add", column: "cruise_line" },
    ]);
    expect(removed.has("quotes")).toBe(false);
  });

  it("keeps the OLD name of a rename removed (last op for old name is the drop)", () => {
    const removed = computeRemovedColumns(
      parseColumnOps([
        { file: "1.sql", content: "ALTER TABLE quotes RENAME COLUMN old_name TO new_name;" },
      ]),
    );
    expect(removed.get("quotes")).toEqual(new Set(["old_name"]));
  });
});

describe("findViolations", () => {
  it("flags a dropped column named in a .select() string (the #137 reader pattern)", () => {
    const removed = new Map([["quotes", new Set(["cruise_line", "sailing_date"])]]);
    const v = findViolations(
      removed,
      [src(`await db.from("quotes").select("id, cruise_line, sailing_date");`)],
    );
    expect(v.map((x) => x.column).sort((a, b) => a.localeCompare(b))).toEqual([
      "cruise_line",
      "sailing_date",
    ]);
    expect(v.every((x) => x.table === "quotes")).toBe(true);
  });

  it("is TABLE-AWARE: a column dropped from quotes but LIVE on bookings is not flagged on the bookings read", () => {
    // cruise_line/sailing_date were dropped from `quotes` but remain live on
    // `bookings` (task-sequence-step-fire reads bookings.cruise_line). A
    // name-only grep would wrongly flag this legitimate reader.
    const removed = new Map([["quotes", new Set(["cruise_line"])]]);
    const v = findViolations(
      removed,
      [src(`await db.from("bookings").select("id, cruise_line, ship_name");`)],
    );
    expect(v).toHaveLength(0);
  });

  it("matches whole words only: dropped total_amount does NOT match the live total_amount_cents", () => {
    const removed = new Map([["quotes", new Set(["total_amount"])]]);
    expect(
      findViolations(removed, [src(`await db.from("quotes").select("id, total_amount_cents");`)]),
    ).toHaveLength(0);
    expect(
      findViolations(removed, [src(`await db.from("quotes").select("id, total_amount");`)]),
    ).toHaveLength(1);
  });

  it("only matches columns inside string literals: a JS property access near a .from is NOT flagged", () => {
    // The submit-route false positive: `booking.cruise_line` (a property access
    // on a live `bookings` row) sits within 800 chars of a `.from("quotes")`
    // whose own .select() never names the dropped column. tsc already checks the
    // property access against the row type, so it is not this gate's concern.
    const removed = new Map([["quotes", new Set(["cruise_line", "ship_name"])]]);
    const content = `
      const { data } = await db.from("quotes")
        .select("id, price_kind, locked_price_cents")
        .eq("converted_to_booking_id", id).maybeSingle();
      const req = {
        cruise_line: booking.cruise_line ?? "",
        ship_name: booking.ship_name ?? "",
      };`;
    expect(findViolations(removed, [src(content)])).toHaveLength(0);
  });

  it("still flags a column that appears BOTH in a select string and as a property access", () => {
    const removed = new Map([["quotes", new Set(["cruise_line"])]]);
    const content = `await db.from("quotes").select("id, cruise_line"); const x = row.cruise_line;`;
    expect(findViolations(removed, [src(content)])).toHaveLength(1);
  });

  it("does not bleed one table's dropped column onto the next table's read (window ends at next .from)", () => {
    // The quotes window ends at the `.from("bookings")`, so cruise_line named in
    // the bookings select is not misattributed to the dropped quotes.cruise_line.
    const removed = new Map([["quotes", new Set(["cruise_line"])]]);
    const content = `await db.from("quotes").select("id, status"); await other.from("bookings").select("id, cruise_line");`;
    expect(findViolations(removed, [src(content)])).toHaveLength(0);
  });
});

describe("parseExceptions", () => {
  it("honors `table.column # reason` and lowercases the key", () => {
    expect(parseExceptions("Quotes.Cruise_Line # historical fixture\n")).toEqual(
      new Set(["quotes.cruise_line"]),
    );
  });

  it("ignores a bare silencing line with no reason and comment lines", () => {
    expect(parseExceptions("# header comment\nquotes.cruise_line\n")).toEqual(new Set());
  });
});

describe("end-to-end (the BP38/#137 incident, reproduced)", () => {
  it("pipes the real contract migration through to flag the broken reader, sparing the _cents superstring", () => {
    const removed = computeRemovedColumns(
      parseColumnOps([
        {
          file: "20260621000002_bp38_quote_options_contract.sql",
          content:
            "ALTER TABLE public.quotes DROP COLUMN IF EXISTS cruise_line, DROP COLUMN IF EXISTS ship_name, DROP COLUMN IF EXISTS total_amount;",
        },
      ]),
    );
    const reader = src(
      `await svc.from("quotes").select("id, tenant_id, cruise_line, ship_name, total_amount_cents");`,
      "q/[token]/page.tsx",
    );
    const v = findViolations(removed, [reader]);
    // cruise_line + ship_name caught; total_amount_cents spared (whole-word vs dropped total_amount).
    expect(v.map((x) => x.column).sort((a, b) => a.localeCompare(b))).toEqual([
      "cruise_line",
      "ship_name",
    ]);
  });
});
