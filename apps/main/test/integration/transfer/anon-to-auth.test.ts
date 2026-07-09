// Integration tests for softCommitTransfer — §11.6
//
// Tests the transfer state machine against mock DB clients.
// Key invariants:
//   - soft commit: sets transfer_soft_commit_at, re-keys conversations/messages
//   - deferred-processing guard: throws DeferredProcessingError during window
//
// Undo consolidated to the wired route (#1647); its coverage lives in
// test/unit/auth/transfer-session-undo.test.ts. The dead undoTransfer() lib fn
// was removed, so its tests moved with the behavior.

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { softCommitTransfer } from "@/lib/transfer/anon-to-auth";
import { assertNotInDeferredWindow, DeferredProcessingError } from "@/lib/transfer/deferred-processing-guard";

// Mock Inngest send so the 24h event emission doesn't error in tests.
vi.mock("@/inngest/client", () => ({
  inngest: { send: vi.fn().mockResolvedValue(undefined) },
}));

// Capture audit-log writes so we can assert the undo snapshot derives its
// message count via conversations (not a nonexistent messages column).
const hoisted = vi.hoisted(() => ({ auditCalls: [] as Record<string, unknown>[] }));
vi.mock("@/lib/audit/write", () => ({
  writeAuditLog: vi.fn(async (row: Record<string, unknown>) => {
    hoisted.auditCalls.push(row);
  }),
}));

const TENANT_ID = "tenant-test-uuid";
const USER_ID = "user-test-uuid";
const ANON_SESSION_ID = "anon-session-uuid";
const CONV_ID = "conv-test-uuid";

// ── Mock DB builder ───────────────────────────────────────────────────────────

interface MockSessionRow {
  id: string;
  transferred_to_user_id: string | null;
  transfer_soft_commit_at: string | null;
  transfer_committed_at: string | null;
  transfer_undo_count: number;
}

type QueryResult = { data: unknown; error: unknown };

// A chainable, thenable Supabase-query stub. Every filter/select method
// (eq/is/not/in/order/select) returns the same chain; awaiting it resolves
// `awaitResult`, and `.maybeSingle()` resolves `singleResult` (falling back
// to `awaitResult`). This models the real fluent builder closely enough to
// exercise CAS `.select("id")` and `.in("conversation_id", …)` shapes.
function buildTransferMockDb(opts: {
  session: MockSessionRow;
  sessionUpdates?: (patch: Record<string, unknown>) => void;
  conversationUpdates?: (patch: Record<string, unknown>) => void;
  convAnonSessionId?: string | null;
  // Rows returned by the undo CAS `.select("id")`; `[]` models "finalize won
  // the race" between the pre-check read and the CAS clear.
  sessionCasRows?: { id: string }[];
  // If set, the CAS UPDATE resolves this error (non-ROW_COUNT_MISMATCH) so we
  // can assert undoTransfer re-throws genuine DB failures.
  sessionCasError?: { message: string; code?: string };
  // Rows the conversations audit-snapshot query returns; `[]` means the
  // session has no conversations, so messages must never be queried.
  convIdRows?: { id: string }[];
  // created_at rows the audit-snapshot message query returns.
  messageRows?: { created_at: string }[];
  // Invoked whenever the messages table is SELECTed (to assert it is skipped
  // when there are no conversations).
  onMessagesSelect?: () => void;
}): SupabaseClient {
  const {
    session,
    sessionUpdates,
    conversationUpdates,
    convAnonSessionId = ANON_SESSION_ID,
    sessionCasRows,
    sessionCasError,
    convIdRows = [{ id: CONV_ID }],
    messageRows = [],
    onMessagesSelect,
  } = opts;
  const currentSession = { ...session };

  function chain(
    awaitResult: () => QueryResult,
    singleResult?: () => QueryResult,
  ): Record<string, unknown> {
    const c: Record<string, unknown> = {};
    for (const m of ["eq", "is", "not", "in", "order", "select"]) {
      c[m] = () => c;
    }
    c.maybeSingle = async () => (singleResult ?? awaitResult)();
    const promise = () => Promise.resolve(awaitResult());
    c.then = (res: (v: QueryResult) => unknown, rej?: (e: unknown) => unknown) =>
      promise().then(res, rej);
    c.catch = (rej: (e: unknown) => unknown) => promise().catch(rej);
    return c;
  }

  return {
    from: (table: string) => {
      if (table === "anonymous_sessions") {
        return {
          select: () =>
            chain(
              () => ({ data: [{ ...currentSession }], error: null }),
              () => ({ data: { ...currentSession }, error: null }),
            ),
          update: (patch: Record<string, unknown>) => {
            Object.assign(currentSession, patch);
            sessionUpdates?.(patch);
            // The undo/finalize CAS chains `.select("id")`; awaiting returns
            // the affected rows so safeAwaitRowCount can assert the count.
            return chain(() =>
              sessionCasError
                ? { data: null, error: sessionCasError }
                : { data: sessionCasRows ?? [{ id: currentSession.id }], error: null },
            );
          },
        };
      }
      if (table === "conversations") {
        return {
          select: () =>
            chain(
              () => ({ data: convIdRows, error: null }),
              () => ({ data: { anonymous_session_id: convAnonSessionId }, error: null }),
            ),
          update: (patch: Record<string, unknown>) => {
            conversationUpdates?.(patch);
            return chain(() => ({ data: null, error: null }));
          },
        };
      }
      if (table === "messages") {
        return {
          select: () => {
            onMessagesSelect?.();
            return chain(() => ({ data: messageRows, error: null }));
          },
        };
      }
      return {
        select: () => chain(() => ({ data: null, error: null })),
        update: () => chain(() => ({ data: null, error: null })),
      };
    },
  } as unknown as SupabaseClient;
}

// ── Transfer happy path ───────────────────────────────────────────────────────

describe("softCommitTransfer — happy path", () => {
  it("sets transfer_soft_commit_at and transferred_to_user_id", async () => {
    const updates: Record<string, unknown>[] = [];

    const db = buildTransferMockDb({
      session: {
        id: ANON_SESSION_ID,
        transferred_to_user_id: null,
        transfer_soft_commit_at: null,
        transfer_committed_at: null,
        transfer_undo_count: 0,
      },
      sessionUpdates: (patch) => updates.push(patch),
    });

    const result = await softCommitTransfer({
      db,
      anonymous_session_id: ANON_SESSION_ID,
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });

    expect(result.status).toBe("soft_committed");
    expect(result.expires_at).toBeTruthy();
    const sessionUpdate = updates.find((p) => "transfer_soft_commit_at" in p);
    expect(sessionUpdate?.transfer_soft_commit_at).toBeTruthy();
    expect(sessionUpdate?.transferred_to_user_id).toBe(USER_ID);
  });

  it("returns expires_at approximately 24 hours from now", async () => {
    const db = buildTransferMockDb({
      session: {
        id: ANON_SESSION_ID,
        transferred_to_user_id: null,
        transfer_soft_commit_at: null,
        transfer_committed_at: null,
        transfer_undo_count: 0,
      },
    });

    const result = await softCommitTransfer({
      db,
      anonymous_session_id: ANON_SESSION_ID,
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });

    const expiresAt = new Date(result.expires_at).getTime();
    const expectedMin = Date.now() + 23 * 60 * 60 * 1000;
    const expectedMax = Date.now() + 25 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThan(expectedMin);
    expect(expiresAt).toBeLessThan(expectedMax);
  });
});

// ── Deferred-processing guard ─────────────────────────────────────────────────

describe("assertNotInDeferredWindow (§11.6)", () => {
  it("throws DeferredProcessingError when session is in soft-commit window", async () => {
    const db = buildTransferMockDb({
      session: {
        id: ANON_SESSION_ID,
        transferred_to_user_id: USER_ID,
        transfer_soft_commit_at: new Date().toISOString(),
        transfer_committed_at: null,
        transfer_undo_count: 0,
      },
    });

    await expect(
      assertNotInDeferredWindow(db, CONV_ID, TENANT_ID),
    ).rejects.toThrow(DeferredProcessingError);
  });

  it("does not throw when session has transfer_committed_at set", async () => {
    const db = buildTransferMockDb({
      session: {
        id: ANON_SESSION_ID,
        transferred_to_user_id: USER_ID,
        transfer_soft_commit_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        transfer_committed_at: new Date().toISOString(),
        transfer_undo_count: 0,
      },
    });

    await expect(assertNotInDeferredWindow(db, CONV_ID, TENANT_ID)).resolves.toBeUndefined();
  });

  it("does not throw when conversation has no anonymous_session_id", async () => {
    const db = buildTransferMockDb({
      session: {
        id: ANON_SESSION_ID,
        transferred_to_user_id: null,
        transfer_soft_commit_at: null,
        transfer_committed_at: null,
        transfer_undo_count: 0,
      },
      convAnonSessionId: null,
    });

    await expect(assertNotInDeferredWindow(db, CONV_ID, TENANT_ID)).resolves.toBeUndefined();
  });

  it("fail-closed: throws when conversations SELECT errors (not silently passes)", async () => {
    const db: SupabaseClient = {
      from: (table: string) => {
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: { message: "DB timeout" } }),
                }),
              }),
            }),
          } as unknown as ReturnType<SupabaseClient["from"]>;
        }
        throw new Error("unexpected table: " + table);
      },
    } as unknown as SupabaseClient;

    await expect(assertNotInDeferredWindow(db, CONV_ID, TENANT_ID)).rejects.toThrow(
      /deferred_window_lookup_failed.*conversations/,
    );
  });

  it("fail-closed: throws when anonymous_sessions SELECT errors (not silently passes)", async () => {
    const db: SupabaseClient = {
      from: (table: string) => {
        if (table === "conversations") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { anonymous_session_id: ANON_SESSION_ID },
                    error: null,
                  }),
                }),
              }),
            }),
          } as unknown as ReturnType<SupabaseClient["from"]>;
        }
        if (table === "anonymous_sessions") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({ data: null, error: { message: "connection reset" } }),
                }),
              }),
            }),
          } as unknown as ReturnType<SupabaseClient["from"]>;
        }
        throw new Error("unexpected table: " + table);
      },
    } as unknown as SupabaseClient;

    await expect(assertNotInDeferredWindow(db, CONV_ID, TENANT_ID)).rejects.toThrow(
      /deferred_window_lookup_failed.*anonymous_sessions/,
    );
  });
});
