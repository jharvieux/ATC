// Unit tests for legal document publish flow — §17.5
//
// Calls the real POST /api/admin/legal-docs route with mocked auth + DB.
// Verifies: version increment, supersede-prior, user-flagging, dedup,
// and cross-type isolation.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  existingDocs:   [] as { id: string; version: number }[],
  existingConsents: [] as { auth_user_id: string }[],
  insertedDocId:  "new-doc-id",
  supersededIds:  [] as string[],
  upsertedRows:   [] as Array<{ auth_user_id: string; document_type: string; document_id_pending: string }>,
  upsertCallCount: 0,
  usersLookupCallCount: 0,
  users:          [] as { auth_user_id: string; email: string }[],
}));

vi.mock("@/lib/auth/assert-platform-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/assert-platform-admin")>(
    "@/lib/auth/assert-platform-admin",
  );
  const gate = async (req: Request) => {
    const adminUserId = req.headers.get("x-admin-user-id");
    if (!adminUserId) throw new actual.PlatformAdminError(401, "missing_bearer", "Missing auth.");
    return { admin_user_id: adminUserId, role: "superadmin" as const, via: "session" as const };
  };
  return {
    ...actual,
    assertPlatformAdmin: vi.fn(gate),
    assertPlatformRole: vi.fn(gate),
    assertPlatformAdminArea: vi.fn(gate),
  };
});

vi.mock("@/lib/db/platform-admin-client", () => ({
  withPlatformAdminAudit: vi.fn(async (
    _opts: unknown,
    fn: (db: unknown, rec: () => void) => Promise<unknown>,
  ) => {
    const db = {
      from: (table: string) => {
        if (table === "legal_documents") {
          return {
            select: () => ({
              eq: () => ({
                order: () => ({
                  limit: () => Promise.resolve({ data: state.existingDocs, error: null }),
                }),
              }),
            }),
            update: () => ({
              eq: (_col: string, id: string) => {
                state.supersededIds.push(id);
                return Promise.resolve({ data: null, error: null });
              },
            }),
            insert: () => ({
              select: () => ({
                single: () => Promise.resolve({
                  data: { id: state.insertedDocId, version: (state.existingDocs[0]?.version ?? 0) + 1 },
                  error: null,
                }),
              }),
            }),
          };
        }
        if (table === "legal_consents") {
          return {
            select: () => ({
              eq: () => ({
                lt: () => ({
                  eq: () => Promise.resolve({ data: state.existingConsents, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === "user_consent_pending") {
          return {
            // #1588: the route now sends a single batched array upsert
            // instead of one call per user.
            upsert: (
              rows: Array<{ auth_user_id: string; document_type: string; document_id_pending: string }>,
              _opts?: unknown,
            ) => {
              state.upsertCallCount++;
              state.upsertedRows.push(...rows);
              return Promise.resolve({ data: null, error: null });
            },
          };
        }
        if (table === "users") {
          // #1588: batched email lookup replacing per-user auth.admin.getUserById.
          return {
            select: () => ({
              in: (_col: string, ids: string[]) => {
                state.usersLookupCallCount++;
                return Promise.resolve({
                  data: state.users.filter((u) => ids.includes(u.auth_user_id)),
                  error: null,
                });
              },
            }),
          };
        }
        return {};
      },
    };
    return fn(db, () => {});
  }),
}));

vi.mock("@/lib/email/notifications", () => ({
  sendPlatformUserEmail: vi.fn(async () => undefined),
}));

async function publishDoc(
  body: { document_type: string; content_markdown: string },
): Promise<Response> {
  const { POST } = await import("@/app/api/admin/legal-docs/route");
  return POST(
    new Request("http://test/api/admin/legal-docs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-user-id": "admin-1" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.existingDocs    = [];
  state.existingConsents = [];
  state.insertedDocId   = "new-doc-id";
  state.supersededIds   = [];
  state.upsertedRows    = [];
  state.upsertCallCount = 0;
  state.usersLookupCallCount = 0;
  state.users           = [];
});

describe("POST /api/admin/legal-docs — publish flow (§17.5)", () => {
  it("first publish of a document type has version 1", async () => {
    const res = await publishDoc({ document_type: "tou", content_markdown: "# Terms" });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; version: number };
    expect(json.ok).toBe(true);
    expect(json.version).toBe(1);
    expect(state.supersededIds).toHaveLength(0);
  });

  it("subsequent publish increments version and supersedes prior", async () => {
    state.existingDocs = [{ id: "doc-1", version: 1 }];
    const res = await publishDoc({ document_type: "tou", content_markdown: "# Terms v2" });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; version: number };
    expect(json.version).toBe(2);
    expect(state.supersededIds).toContain("doc-1");
  });

  it("flags users whose accepted consents are below the new version", async () => {
    state.existingDocs    = [{ id: "doc-1", version: 1 }];
    state.existingConsents = [{ auth_user_id: "user-a" }, { auth_user_id: "user-b" }];
    state.insertedDocId   = "doc-2";
    const res = await publishDoc({ document_type: "tou", content_markdown: "# Terms v2" });
    expect(res.status).toBe(200);
    const flagged = state.upsertedRows.map((r) => r.auth_user_id);
    expect(flagged).toContain("user-a");
    expect(flagged).toContain("user-b");
    expect(state.upsertedRows[0]?.document_id_pending).toBe("doc-2");
  });

  it("deduplicates users who have multiple old accepted consent rows", async () => {
    state.existingDocs    = [{ id: "doc-1", version: 2 }];
    state.existingConsents = [{ auth_user_id: "user-a" }, { auth_user_id: "user-a" }];
    const res = await publishDoc({ document_type: "privacy_policy", content_markdown: "# Privacy v3" });
    expect(res.status).toBe(200);
    expect(state.upsertedRows).toHaveLength(1);
    expect(state.upsertedRows[0]?.auth_user_id).toBe("user-a");
  });

  it("writes no pending rows when no users have old accepted consents", async () => {
    state.existingDocs    = [{ id: "doc-1", version: 1 }];
    state.existingConsents = [];
    const res = await publishDoc({ document_type: "tou", content_markdown: "# Terms v2" });
    expect(res.status).toBe(200);
    expect(state.upsertedRows).toHaveLength(0);
  });

  it("pending rows carry the correct document_type", async () => {
    state.existingDocs    = [{ id: "tou-1", version: 1 }];
    state.existingConsents = [{ auth_user_id: "user-a" }];
    state.insertedDocId   = "tou-2";
    const res = await publishDoc({ document_type: "tou", content_markdown: "# TOU v2" });
    expect(res.status).toBe(200);
    expect(state.upsertedRows.every((r) => r.document_type === "tou")).toBe(true);
  });

  // #1588: a publish affecting 2000+ users used to issue one
  // user_consent_pending.upsert round-trip AND one auth.admin.getUserById
  // round-trip PER USER — 4000+ serial DB calls in the one admin request
  // that must succeed. Pin that a large flagged-user set now collapses to
  // one batched upsert call and one batched users-table lookup call
  // (rather than scaling 1:1 with user count).
  it("batches the pending-row upsert and email lookup into a single round-trip each, regardless of flagged-user count", async () => {
    state.existingDocs = [{ id: "doc-1", version: 1 }];
    state.existingConsents = Array.from({ length: 50 }, (_, i) => ({ auth_user_id: `user-${i}` }));
    state.users = state.existingConsents.map((c) => ({ auth_user_id: c.auth_user_id, email: `${c.auth_user_id}@example.com` }));

    const res = await publishDoc({ document_type: "tou", content_markdown: "# Terms v2" });

    expect(res.status).toBe(200);
    expect(state.upsertedRows).toHaveLength(50);
    expect(state.upsertCallCount).toBe(1); // one batched array upsert, not 50 serial calls
    expect(state.usersLookupCallCount).toBe(1); // one batched .in() lookup, not 50 getUserById calls
  });
});

describe.skip("CCPA deletion grace period (§17.10) — awaiting implementation", () => {
  it.todo("undo is valid within 30 days");
  it.todo("undo is invalid after 30 days");
  it.todo("purge job with mismatched deleted_at is skipped (stale)");
  it.todo("purge job with null deleted_at is skipped (undo was called)");
});

describe.skip("CCPA export rate limit (§17.9) — awaiting implementation", () => {
  it.todo("first export request within 30d is not rate-limited");
  it.todo("second request within 30d is rate-limited");
  it.todo("request older than 30d does not block a new request");
});

describe.skip("CCPA staging propagation threshold (§17.10) — awaiting implementation", () => {
  it.todo("alert fires when last refresh is 25+ days ago");
  it.todo("no alert when last refresh is < 25 days ago");
});
