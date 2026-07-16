// #1936 (D-091 #22) — the retrieval-weights PUT applies every per-key
// platform_settings change through ONE atomic RPC (platform_settings_apply_updates)
// instead of a per-key fan-out. Before, each UPDATE autocommitted independently
// (withPlatformAdminAudit opens no transaction), so a mixed PUT where one key
// matched no row committed the applied key in main, threw 500, and published no
// RAG-sync event — leaving main and the rag replica diverged for up to 24h with
// the admin unaware a key had taken effect. These tests pin: the route issues a
// SINGLE rpc call carrying every requested key (never a per-key write — the mock
// db exposes no .update, so any fan-out attempt throws); any RPC failure (DB
// error OR a raised "matched no row") aborts the whole PUT with a generic
// db_error 500 and NO publish, so a partial apply is unobservable; and the
// applied/failed detail never reaches the client body.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  // Each element is the p_changes array of one rpc invocation. A correct
  // atomic route produces exactly one call per PUT.
  rpcCalls: [] as Array<Array<{ key: string; value: unknown }>>,
  // Keys that make the atomic RPC fail with a DB error (rollback: no key applied).
  failKeys: new Set<string>(),
  // Keys that make the atomic RPC RAISE "matched no row" (the seed-row-deleted
  // case — also a full rollback under the single-transaction function).
  missingRowKeys: new Set<string>(),
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
      // No `.update` on purpose: the route must go through `.rpc`. A regression
      // to per-key `.from(...).update(...)` throws "update is not a function".
      from: (_table: string) => ({
        select: () => ({
          in: async () => (h.readError ? { data: null, error: h.readError } : { data: h.currentRows, error: null }),
        }),
      }),
      rpc: async (_fn: string, args: { p_changes: Array<{ key: string; value: unknown }> }) => {
        h.rpcCalls.push(args.p_changes);
        const failed = args.p_changes.find((c) => h.failKeys.has(c.key));
        if (failed) return { data: null, error: { message: `apply_updates failed at ${failed.key}` } };
        const missing = args.p_changes.find((c) => h.missingRowKeys.has(c.key));
        if (missing) {
          return { data: null, error: { message: `platform_settings key ${missing.key} matched no row`, code: "P0002" } };
        }
        return {
          data: args.p_changes.map((c) => ({ setting_key: c.key, setting_updated_at: "2026-07-13T00:00:00.000Z" })),
          error: null,
        };
      },
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
  h.rpcCalls = [];
  h.failKeys = new Set();
  h.missingRowKeys = new Set();
  h.currentRows = [];
  h.readError = null;
  h.publishPlatformEvent.mockClear();
});

describe("PUT /api/admin/retrieval-weights — atomic apply (#1936)", () => {
  it("applies every requested key through a single RPC and returns the re-read values", async () => {
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

    // Exactly ONE atomic call carrying both keys — not a per-key fan-out.
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.rpcCalls[0]!.map((c) => c.key).sort()).toEqual([
      "retrieval_weight_feedback",
      "retrieval_weight_match",
    ]);
  });

  it("a single failing key aborts the whole PUT — no key applied, no sync (atomicity)", async () => {
    h.failKeys = new Set(["retrieval_weight_match"]);
    const res = await PUT(req({ match: 3, authority: 4, recency: 5 }));

    // Generic db_error 500 — no key names / raw DB details in the client body.
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "db_error" });
    expect(JSON.stringify(body)).not.toContain("retrieval_weight");

    // The atomicity guarantee: all three keys went into ONE transactional RPC
    // and it rolled back. There is no per-key path that could have persisted
    // authority/recency while match failed. Nothing may reach rag.
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.rpcCalls[0]!.map((c) => c.key).sort()).toEqual([
      "retrieval_weight_authority",
      "retrieval_weight_match",
      "retrieval_weight_recency",
    ]);
    expect(h.publishPlatformEvent).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range weight before touching the DB", async () => {
    const res = await PUT(req({ match: 99 }));
    expect(res.status).toBe(422);
    expect(h.rpcCalls).toEqual([]);
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
    // source_revision comes from the RPC's returned updated_at (DB write time),
    // not Date.now() at call time — see route.ts's PUT handler.
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

describe("PUT /api/admin/retrieval-weights — zero-row / missing seed row (#1909, now via the atomic RPC RAISE)", () => {
  // A missing platform_settings row (someone deleted a seed) makes the RPC
  // RAISE "matched no row", aborting the whole transaction. A mixed PUT where
  // one key's row is missing must leave NO key applied and publish nothing —
  // the pre-#1936 fan-out committed the sibling key and diverged main from rag.
  it("fails the whole PUT when ONE key's row is missing even though a sibling key would apply", async () => {
    h.missingRowKeys = new Set(["retrieval_weight_match"]);
    const res = await PUT(req({ match: 3, authority: 4 }));

    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "db_error" });
    expect(h.rpcCalls).toHaveLength(1);
    expect(h.publishPlatformEvent).not.toHaveBeenCalled();
  });

  it("fails loud for a single-key request whose row is missing", async () => {
    h.missingRowKeys = new Set(["retrieval_weight_match"]);
    const res = await PUT(req({ match: 3 }));
    expect(res.status).toBe(500);
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

  // #1937 — the read used to throw `... ${String(error)}`, which on a
  // PostgrestError object logged "[object Object]" and destroyed the
  // diagnostic. The thrown error handed to dbErrorResponse must now carry the
  // real DB message. Regressing to String(error) fails this test.
  it("surfaces the underlying DB message to the server log, not [object Object] (#1937)", async () => {
    h.readError = { message: "permission denied for table platform_settings" };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await GET(new Request("https://app.example.com/api/admin/retrieval-weights"));
    expect(res.status).toBe(500);

    const logged = errorSpy.mock.calls
      .flat()
      .map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a)))
      .join(" ");
    expect(logged).toContain("permission denied for table platform_settings");
    expect(logged).not.toContain("[object Object]");
    errorSpy.mockRestore();
  });
});
