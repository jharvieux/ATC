// §17.9 CCPA export — data-access shape (regression guard for #1190).
//
// The bug: the export keyed bookings + conversations on auth_user_id, but those
// tables link by user_id (= users.id). So every export returned zero bookings
// and zero conversations. The fix resolves users.id first, then queries by
// user_id; legal_consents keeps auth_user_id (it has that column). This pins
// the linkage and the corrected column allowlists — a revert silently empties
// a user's CCPA export.

import { describe, it, expect } from "vitest";
import { collectUserDbExport } from "@/inngest/user-data-export-build";

type Call = { table: string; select?: string; col?: string; val?: unknown };

function makeDb(rowsByTable: Record<string, unknown[]>, calls: Call[]) {
  return {
    from(table: string) {
      return {
        select(cols: string) {
          calls.push({ table, select: cols });
          return {
            eq(col: string, val: unknown) {
              calls.push({ table, col, val });
              return Promise.resolve({ data: rowsByTable[table] ?? [] });
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof collectUserDbExport>[0];
}

describe("collectUserDbExport (#1190)", () => {
  it("resolves users.id and keys bookings + conversations on user_id, consents on auth_user_id", async () => {
    const calls: Call[] = [];
    const db = makeDb(
      {
        users: [{ id: "user-uuid-1", email: "u@example.com" }],
        conversations: [{ id: "c1" }],
        bookings: [{ id: "b1" }],
        legal_consents: [{ id: "lc1", document_type: "tos" }],
      },
      calls,
    );

    const result = await collectUserDbExport(db, "auth-xyz");

    const eqCalls = calls.filter((c) => c.col !== undefined);
    expect(eqCalls).toContainEqual({ table: "users", col: "auth_user_id", val: "auth-xyz" });
    // The core fix: bookings + conversations key on the RESOLVED user_id,
    // never auth_user_id (which is not a column on those tables).
    expect(eqCalls).toContainEqual({ table: "conversations", col: "user_id", val: "user-uuid-1" });
    expect(eqCalls).toContainEqual({ table: "bookings", col: "user_id", val: "user-uuid-1" });
    expect(eqCalls).toContainEqual({ table: "legal_consents", col: "auth_user_id", val: "auth-xyz" });

    expect(result.bookings).toEqual([{ id: "b1" }]);
    expect(result.conversations).toEqual([{ id: "c1" }]);
    expect(result.legal_consents).toEqual([{ id: "lc1", document_type: "tos" }]);
  });

  it("selects the corrected columns — no non-existent source/doc_type/accepted_at", async () => {
    const calls: Call[] = [];
    const db = makeDb({ users: [{ id: "u1" }], conversations: [], bookings: [], legal_consents: [] }, calls);
    await collectUserDbExport(db, "auth-xyz");

    const bookingsSelect = calls.find((c) => c.table === "bookings" && c.select)?.select ?? "";
    expect(bookingsSelect).toContain("cruise_line");
    expect(bookingsSelect).not.toContain("source");
    expect(bookingsSelect).not.toContain("booked_at");

    const consentsSelect = calls.find((c) => c.table === "legal_consents" && c.select)?.select ?? "";
    expect(consentsSelect).toContain("document_type");
    expect(consentsSelect).toContain("acted_at");
    expect(consentsSelect).not.toContain("doc_type");
    expect(consentsSelect).not.toContain("accepted_at");
  });

  it("skips the bookings/conversations queries entirely when no user is found", async () => {
    const calls: Call[] = [];
    const db = makeDb({ users: [], legal_consents: [] }, calls);

    const result = await collectUserDbExport(db, "auth-none");

    expect(result.bookings).toEqual([]);
    expect(result.conversations).toEqual([]);
    // No user → no user_id → those tables must not be queried at all.
    expect(calls.find((c) => c.table === "bookings")).toBeUndefined();
    expect(calls.find((c) => c.table === "conversations")).toBeUndefined();
    // legal_consents is keyed on auth_user_id, so it is still queried.
    expect(calls.some((c) => c.table === "legal_consents")).toBe(true);
  });
});
