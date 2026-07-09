// #1613 item 6 — unit tests for the unbounded-select guard's matcher.
//
// Pins what counts as a violation (a .select() on a user-growing table with no
// .limit()/.range()) vs. what must NOT (bounded queries, unwatched tables,
// mutations). A regression here would either miss a silent-truncation bug
// (false negative) or spam the baseline (false positive).

import { describe, it, expect } from "vitest";
import { findUnbounded } from "../../../scripts/check-unbounded-select";

const tables = (src: string): string[] => findUnbounded("r.ts", src).map((f) => f.table);

describe("findUnbounded — flags unbounded reads of user-growing tables", () => {
  it("flags .from('messages').select() with only .eq() filters", () => {
    expect(tables(`await db.from("messages").select("id").eq("tenant_id", t);`)).toEqual(["messages"]);
  });

  it("flags a forum_ prefix-family table", () => {
    expect(tables(`await db.from("forum_threads").select("*").eq("forum_id", f);`)).toEqual([
      "forum_threads",
    ]);
  });

  it("flags email_log count-by-fetch (the rate-limit bug shape)", () => {
    expect(
      tables(`const { data } = await db.from("email_log").select("id").eq("tenant_id", t).gte("sent_at", d);`),
    ).toEqual(["email_log"]);
  });
});

describe("findUnbounded — does NOT flag bounded or non-read forms", () => {
  it("ignores a chain with .limit()", () => {
    expect(tables(`await db.from("messages").select("id").eq("x", y).limit(50);`)).toEqual([]);
  });

  it("ignores a chain with .range()", () => {
    expect(tables(`await db.from("conversations").select("*").range(0, 49);`)).toEqual([]);
  });

  it("ignores .single()/.maybeSingle() single-row reads", () => {
    expect(tables(`await db.from("quotes").select("*").eq("id", id).maybeSingle();`)).toEqual([]);
  });

  it("ignores head:true count-only reads", () => {
    expect(
      tables(`await db.from("messages").select("*", { count: "exact", head: true }).eq("x", y);`),
    ).toEqual([]);
  });

  it("ignores a mutation (no .select())", () => {
    expect(tables(`await db.from("messages").insert(row);`)).toEqual([]);
  });

  it("ignores tables not on the watchlist", () => {
    expect(tables(`await db.from("tenants").select("*");`)).toEqual([]);
  });

  it("does not let a select on the NEXT statement clear the finding", () => {
    // The window ends at the first ';', so a bounded query later can't mask an
    // unbounded one earlier.
    const src = `await db.from("messages").select("id").eq("x", y);
await db.from("other").select("*").limit(1);`;
    expect(tables(src)).toEqual(["messages"]);
  });
});
