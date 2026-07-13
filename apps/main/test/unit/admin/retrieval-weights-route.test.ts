// PR #1827 — the retrieval-weights PUT was parallelized (Promise.allSettled
// over the per-key platform_settings updates). These tests pin the behavioral
// guarantee allSettled was chosen for: a mid-batch failure must NOT abandon
// the sibling keys' updates (fail-fast Promise.all would race them and lose
// track of which applied), and the client still gets only the generic
// dbErrorResponse body — the applied/failed key split goes to server logs,
// never the response. A regression back to fail-fast leaves the weights (a
// cohesive scoring config read together downstream) in an unreported
// partial state.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  updates: [] as Array<{ key: string; value: unknown }>,
  // Keys whose update should fail with a DB error.
  failKeys: new Set<string>(),
  // Rows returned by the post-update loadCurrent read.
  currentRows: [] as Array<{ key: string; value: unknown }>,
}));

vi.mock("@/lib/auth/assert-platform-admin", () => ({
  assertPlatformAdminArea: async () => ({ admin_user_id: "admin-user-1" }),
  PlatformAdminError: class extends Error {},
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: async (
    _opts: unknown,
    fn: (db: unknown, recordQuery: (q: unknown) => void) => Promise<unknown>,
  ) => {
    const db = {
      from: (_table: string) => ({
        update: (payload: { value: unknown }) => ({
          eq: async (_col: string, key: string) => {
            h.updates.push({ key, value: payload.value });
            return h.failKeys.has(key)
              ? { error: { message: `write failed for ${key}` } }
              : { error: null };
          },
        }),
        select: () => ({
          in: async () => ({ data: h.currentRows, error: null }),
        }),
      }),
    };
    return fn(db, () => {});
  },
}));

import { PUT } from "@/app/api/admin/retrieval-weights/route";

function req(body: unknown): Request {
  return new Request("https://app.example.com/api/admin/retrieval-weights", {
    method: "PUT",
    headers: { "content-type": "application/json", Authorization: "Bearer admin" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  h.updates = [];
  h.failKeys = new Set();
  h.currentRows = [];
});

describe("PUT /api/admin/retrieval-weights — parallel per-key updates (#1827)", () => {
  it("updates every requested key and returns the re-read values", async () => {
    h.currentRows = [
      { key: "retrieval_weight_match", value: 2 },
      { key: "retrieval_weight_feedback", value: 0.5 },
    ];
    const res = await PUT(req({ match: 2, feedback: 0.5 }));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { updated: string[]; values: Record<string, number> };
    expect(body.updated.sort()).toEqual(["feedback", "match"]);
    // Values come from the post-update re-read, not the request echo.
    expect(body.values).toMatchObject({ match: 2, feedback: 0.5, authority: 1, recency: 1 });

    const updatedKeys = h.updates.map((u) => u.key).sort();
    expect(updatedKeys).toEqual(["retrieval_weight_feedback", "retrieval_weight_match"]);
  });

  it("one key failing still attempts the sibling updates (allSettled, not fail-fast)", async () => {
    h.failKeys = new Set(["retrieval_weight_match"]);
    const res = await PUT(req({ match: 3, authority: 4, recency: 5 }));

    // Failure surfaces as the generic db_error 500 — no key names, no raw
    // DB details in the client-visible body (the applied/failed split is
    // server-log-only).
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "db_error" });
    expect(JSON.stringify(body)).not.toContain("retrieval_weight");

    // The behavioral guarantee: ALL three updates were attempted despite
    // the match-key failure. Fail-fast would have left authority/recency
    // in-flight with their outcome unobserved.
    const attemptedKeys = h.updates.map((u) => u.key).sort();
    expect(attemptedKeys).toEqual([
      "retrieval_weight_authority",
      "retrieval_weight_match",
      "retrieval_weight_recency",
    ]);
  });

  it("rejects an out-of-range weight before touching the DB", async () => {
    const res = await PUT(req({ match: 99 }));
    expect(res.status).toBe(422);
    expect(h.updates).toEqual([]);
  });
});
