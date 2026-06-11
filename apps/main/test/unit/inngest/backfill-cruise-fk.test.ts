// #781 — backfill-cruise-fk: verifies that the update object is built
// conditionally — only matched FKs are written, so a previously-resolved
// cruise_ship_id is never overwritten with null on a re-run.

import { describe, expect, it, vi } from "vitest";

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_cfg: unknown, handler: unknown) => handler,
  },
}));

// Capture update calls so we can assert what was written.
const updatePayloads: Record<string, unknown>[] = [];

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from(_table: string) {
      return {
        select(_cols: string) {
          const chain: Record<string, unknown> = {
            or() { return chain; },
            not() { return chain; },
            order() { return chain; },
            limit() { return chain; },
            gt() { return chain; },
            is() { return chain; },
            then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
              // Return one row for quote_options, none for the rest.
              if (_table === "quote_options") {
                return resolve({
                  data: [{ id: "row-1", cruise_line: "Royal Caribbean", ship_name: "Harmony" }],
                  error: null,
                });
              }
              return resolve({ data: [], error: null });
            },
          };
          return chain;
        },
        update(payload: Record<string, unknown>) {
          updatePayloads.push(payload);
          return { eq: () => Promise.resolve({ data: null, error: null }) };
        },
        upsert() {
          return Promise.resolve({ error: null });
        },
      };
    },
  }),
}));

// resolveCanonical: line matches, ship does not match.
vi.mock("@/lib/canonical/resolve-canonical", () => ({
  resolveCanonical: vi.fn(async (_raw: unknown, entityType: string) => {
    if (entityType === "line") return { matched: true, id: "line-id-1" };
    return { matched: false };
  }),
  queueForReview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: vi.fn(async (query: unknown) => query),
}));

import { backfillCruiseFk } from "@/inngest/backfill-cruise-fk";

const stepRun = vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn());
const run = backfillCruiseFk as unknown as (ctx: { event: { data: unknown }; step: unknown }) => Promise<unknown>;

describe("backfill-cruise-fk — conditional FK update", () => {
  it("only writes cruise_line_id when line matched; does not write cruise_ship_id", async () => {
    updatePayloads.length = 0;
    await run({ event: { data: { tables: ["quote_options"] } }, step: { run: stepRun } });

    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0]).toHaveProperty("cruise_line_id", "line-id-1");
    expect(updatePayloads[0]).not.toHaveProperty("cruise_ship_id");
  });

  it("writes no update when neither line nor ship matches", async () => {
    // Re-mock resolveCanonical to always return unmatched.
    const { resolveCanonical } = await import("@/lib/canonical/resolve-canonical");
    vi.mocked(resolveCanonical).mockResolvedValue({ matched: false });

    updatePayloads.length = 0;
    await run({ event: { data: { tables: ["quote_options"] } }, step: { run: stepRun } });

    expect(updatePayloads).toHaveLength(0);
  });
});
