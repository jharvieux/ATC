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
  // Keys whose update "succeeds" (error: null) but returns no matched row —
  // exercises the #1909 per-key zero-row assert (D-091 #7).
  emptyRowKeys: new Set<string>(),
  // Rows returned by the post-update loadCurrent read.
  currentRows: [] as Array<{ key: string; value: unknown }>,
  // When set, the loadCurrent read returns this error instead of rows.
  readError: null as { message: string } | null,
  publishPlatformEvent: vi.fn(async (_event: unknown) => undefined),
}));

vi.mock("@/lib/auth/assert-platform-admin", () => ({
  assertPlatformAdminArea: async () => ({ admin_user_id: "admin-user-1" }),
  PlatformAdminError: class extends Error {},
}));

vi.mock("@/lib/rag-sync/publish-platform-event", () => ({
  publishPlatformEvent: h.publishPlatformEvent,
}));

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: async (
    _opts: unknown,
    fn: (db: unknown, recordQuery: (q: unknown) => void) => Promise<unknown>,
  ) => {
    const db = {
      from: (_table: string) => ({
        update: (payload: { value: unknown }) => ({
          eq: (_col: string, key: string) => ({
            select: async (_cols: string) => {
              h.updates.push({ key, value: payload.value });
              if (h.failKeys.has(key)) {
                return { data: null, error: { message: `write failed for ${key}` } };
              }
              if (h.emptyRowKeys.has(key)) {
                return { data: [], error: null };
              }
              return { data: [{ updated_at: "2026-07-13T00:00:00.000Z" }], error: null };
            },
          }),
        }),
        select: () => ({
          in: async () => (h.readError ? { data: null, error: h.readError } : { data: h.currentRows, error: null }),
        }),
      }),
    };
    return fn(db, () => {});
  },
}));

import { GET, PUT } from "@/app/api/admin/retrieval-weights/route";

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
  h.emptyRowKeys = new Set();
  h.currentRows = [];
  h.readError = null;
  h.publishPlatformEvent.mockClear();
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

describe("PUT /api/admin/retrieval-weights — RAG-sync publish (#1826)", () => {
  it("calls publishPlatformEvent with the changed keys/values after a successful save", async () => {
    h.currentRows = [
      { key: "retrieval_weight_match", value: 2 },
      { key: "retrieval_weight_feedback", value: 0.5 },
    ];
    const res = await PUT(req({ match: 2, feedback: 0.5 }));
    expect(res.status).toBe(200);

    expect(h.publishPlatformEvent).toHaveBeenCalledTimes(1);
    const event = h.publishPlatformEvent.mock.calls[0]![0] as {
      event_type: string;
      source_revision: number;
      payload: { changes: Array<{ key: string; value: unknown }> };
    };
    expect(event.event_type).toBe("platform_settings.updated");
    // source_revision comes from the updated row's updated_at (DB write
    // time), not Date.now() at call time — see route.ts's PUT handler.
    expect(event.source_revision).toBe(Math.floor(new Date("2026-07-13T00:00:00.000Z").getTime() / 1000));
    expect(event.payload.changes.slice().sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "retrieval_weight_feedback", value: 0.5 },
      { key: "retrieval_weight_match", value: 2 },
    ]);
  });

  it("does not call publishPlatformEvent when the DB write fails", async () => {
    h.failKeys = new Set(["retrieval_weight_match"]);
    const res = await PUT(req({ match: 3 }));
    expect(res.status).toBe(500);
    expect(h.publishPlatformEvent).not.toHaveBeenCalled();
  });
});

describe("PUT /api/admin/retrieval-weights — zero-row update (#1909)", () => {
  // D-091 #7: supabase-js v2 returns error:null + data:[] when an UPDATE
  // matches no row. The pre-#1909 route only failed when EVERY key came back
  // empty, so a mixed PUT — one seeded key, one missing row — reported 200 and
  // published a RAG-sync event while the missing key silently never persisted.
  // The admin's change was lost with no signal. Reverting to the aggregate
  // check (or dropping the per-key assert) must fail this test.
  it("fails the whole PUT when ONE key's row is missing even though a sibling key applied", async () => {
    h.emptyRowKeys = new Set(["retrieval_weight_match"]);
    const res = await PUT(req({ match: 3, authority: 4 }));

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "db_error" });
    // Nothing may reach rag: publishing a partial change would sync the
    // applied key and leave the lost one silently diverged.
    expect(h.publishPlatformEvent).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/retrieval-weights — read error (#1909)", () => {
  // A discarded read error rendered the seed defaults (1.0 across the board)
  // as if they were live config — an admin could "correct" a value that was
  // never wrong. The read must fail loud instead.
  it("returns db_error rather than seed defaults when the settings read fails", async () => {
    h.readError = { message: "connection reset" };
    const res = await GET(new Request("https://app.example.com/api/admin/retrieval-weights"));

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "db_error" });
    expect(body).not.toMatchObject({ match: 1 });
  });
});

describe("PUT /api/admin/retrieval-weights — all-keys-empty case still fails (#1887, now via #1909 per-key assert)", () => {
  it("fails loud when the only requested key's row is missing, before source_revision's Math.max ever runs", async () => {
    // #1887 originally guarded this exact all-keys-empty case with an
    // aggregate `updatedAts.length === 0` check ahead of
    // `Math.max(...updatedAts.map(...))`, which would otherwise silently
    // yield -Infinity and poison source_revision. #1909 replaced that
    // aggregate check with a per-key throw inside the allSettled map (see
    // the "zero-row update (#1909)" describe block above), which now fires
    // for this same request before the route ever reaches the Math.max
    // call — so the -Infinity path is structurally unreachable rather than
    // merely guarded. This test is kept to confirm a single-key request
    // with a missing row still fails loud under the new mechanism.
    h.emptyRowKeys = new Set(["retrieval_weight_match"]);
    const res = await PUT(req({ match: 3 }));
    expect(res.status).toBe(500);
    expect(h.publishPlatformEvent).not.toHaveBeenCalled();
  });
});
