// §38.8.1 / §39.5 — Token resolver: quotes first, then trip_itineraries, null otherwise.

import { describe, it, expect } from "vitest";
import { resolvePublicToken } from "@/lib/chat/public-token-resolver";

function makeDb(routes: Record<string, { table: string; row: Record<string, unknown> | null }>) {
  return {
    from(table: string) {
      let currentToken = "";
      const chain = {
        select: () => chain,
        eq: (col: string, val: string) => {
          if (col === "customer_access_token" || col === "access_token") currentToken = val;
          return chain;
        },
        maybeSingle: async () => {
          const hit = routes[`${table}:${currentToken}`];
          return { data: hit?.row ?? null, error: null };
        },
      };
      return chain;
    },
  } as unknown as Parameters<typeof resolvePublicToken>[0];
}

describe("resolvePublicToken", () => {
  it("returns kind='quote' when token matches a quote", async () => {
    const db = makeDb({
      "quotes:abc1234567890123": { table: "quotes", row: { id: "q1", tenant_id: "t1", status: "sent" } },
    });
    const r = await resolvePublicToken(db, "abc1234567890123");
    expect(r).toEqual({ kind: "quote", quote_id: "q1", tenant_id: "t1", status: "sent" });
  });

  it("falls back to trip_itineraries when no quote matches", async () => {
    const db = makeDb({
      "trip_itineraries:def4567890123456": {
        table: "trip_itineraries",
        row: { id: "i1", booking_id: "b1", tenant_id: "t2", status: "sent" },
      },
    });
    const r = await resolvePublicToken(db, "def4567890123456");
    expect(r).toEqual({
      kind: "trip_itinerary",
      itinerary_id: "i1",
      booking_id: "b1",
      tenant_id: "t2",
      status: "sent",
    });
  });

  it("returns null when token matches neither", async () => {
    const db = makeDb({});
    const r = await resolvePublicToken(db, "nonexistent123456");
    expect(r).toBeNull();
  });

  it("returns null on short tokens (rejects probes)", async () => {
    const db = makeDb({});
    expect(await resolvePublicToken(db, "short")).toBeNull();
    expect(await resolvePublicToken(db, "")).toBeNull();
  });

  it("returns null on excessively long tokens", async () => {
    const db = makeDb({});
    expect(await resolvePublicToken(db, "x".repeat(257))).toBeNull();
  });

  it("prefers the quote match if both tables somehow share the same token", async () => {
    // Defensive: tokens should be globally unique but if collision ever
    // happens, the quote wins (caller passes resolved.kind explicitly).
    const db = makeDb({
      "quotes:dup1234567890123": { table: "quotes", row: { id: "q1", tenant_id: "t1", status: "sent" } },
      "trip_itineraries:dup1234567890123": {
        table: "trip_itineraries",
        row: { id: "i1", booking_id: "b1", tenant_id: "t2", status: "sent" },
      },
    });
    const r = await resolvePublicToken(db, "dup1234567890123");
    expect(r?.kind).toBe("quote");
  });
});
