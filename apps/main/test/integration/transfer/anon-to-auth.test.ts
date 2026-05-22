// Integration tests for softCommitTransfer and undoTransfer — §11.6
//
// Tests the transfer state machine against mock DB clients.
// Key invariants:
//   - soft commit: sets transfer_soft_commit_at, re-keys conversations/messages
//   - undo within window: reverts re-keying, clears commit state, increments undo_count
//   - undo after finalize: returns 409 without modifying any state
//   - deferred-processing guard: throws DeferredProcessingError during window

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { softCommitTransfer, undoTransfer } from "@/lib/transfer/anon-to-auth";
import { assertNotInDeferredWindow, DeferredProcessingError } from "@/lib/transfer/deferred-processing-guard";

// Mock Inngest send so the 24h event emission doesn't error in tests.
vi.mock("@/inngest/client", () => ({
  inngest: { send: vi.fn().mockResolvedValue(undefined) },
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

function buildTransferMockDb(opts: {
  session: MockSessionRow;
  sessionUpdates?: (patch: Record<string, unknown>) => void;
  conversationUpdates?: (patch: Record<string, unknown>) => void;
  convAnonSessionId?: string | null;
}): SupabaseClient {
  const { session, sessionUpdates, conversationUpdates, convAnonSessionId = ANON_SESSION_ID } = opts;
  const currentSession = { ...session };

  return {
    from: (table: string) => {
      if (table === "anonymous_sessions") {
        return {
          select: () => ({
            eq: (_c: string, _v: string) => ({
              maybeSingle: async () => ({ data: { ...currentSession }, error: null }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: (_c: string, _v: string) => {
              Object.assign(currentSession, patch);
              sessionUpdates?.(patch);
              return Promise.resolve({ data: null, error: null });
            },
          }),
        };
      }
      if (table === "conversations") {
        return {
          select: () => ({
            eq: (_c: string, _v: string) => ({
              maybeSingle: async () => ({
                data: { anonymous_session_id: convAnonSessionId },
                error: null,
              }),
              eq: (_c2: string, _v2: string) => ({
                select: () => ({ data: [{ id: CONV_ID }], error: null }),
              }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: (_c: string, _v: string) => {
              conversationUpdates?.(patch);
              return Promise.resolve({ data: null, error: null });
            },
          }),
        };
      }
      if (table === "messages") {
        return {
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
          select: () => ({
            eq: () => ({
              order: () => ({ data: [], error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
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

// ── Transfer undo within 24h window ──────────────────────────────────────────

describe("undoTransfer — within window", () => {
  it("clears soft_commit_at, increments undo_count, reverts conversations", async () => {
    const softCommitAt = new Date().toISOString();
    const sessionUpdates: Record<string, unknown>[] = [];
    const convUpdates: Record<string, unknown>[] = [];

    const db = buildTransferMockDb({
      session: {
        id: ANON_SESSION_ID,
        transferred_to_user_id: USER_ID,
        transfer_soft_commit_at: softCommitAt,
        transfer_committed_at: null,
        transfer_undo_count: 0,
      },
      sessionUpdates: (p) => sessionUpdates.push(p),
      conversationUpdates: (p) => convUpdates.push(p),
    });

    const result = await undoTransfer({
      db,
      anonymous_session_id: ANON_SESSION_ID,
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });

    expect(result).toEqual({ status: "undone" });

    const clearUpdate = sessionUpdates.find((p) => "transfer_soft_commit_at" in p);
    expect(clearUpdate?.transfer_soft_commit_at).toBeNull();
    expect(clearUpdate?.transferred_to_user_id).toBeNull();
    expect(clearUpdate?.transfer_undo_count).toBe(1);

    // Conversations should be reverted to null user_id.
    const convRevert = convUpdates.find((p) => "user_id" in p);
    expect(convRevert?.user_id).toBeNull();
  });
});

// ── Transfer undo after finalize ──────────────────────────────────────────────

describe("undoTransfer — after finalize (§11.6)", () => {
  it("returns 409 when transfer_committed_at is set", async () => {
    const db = buildTransferMockDb({
      session: {
        id: ANON_SESSION_ID,
        transferred_to_user_id: USER_ID,
        transfer_soft_commit_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        transfer_committed_at: new Date().toISOString(), // already committed
        transfer_undo_count: 0,
      },
    });

    const result = await undoTransfer({
      db,
      anonymous_session_id: ANON_SESSION_ID,
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });

    expect(result).toEqual({ error: "transfer_already_finalized", status: 409 });
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
      assertNotInDeferredWindow(db, CONV_ID),
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

    await expect(assertNotInDeferredWindow(db, CONV_ID)).resolves.toBeUndefined();
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

    await expect(assertNotInDeferredWindow(db, CONV_ID)).resolves.toBeUndefined();
  });
});
