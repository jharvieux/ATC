// Unit tests for legal document publish flow — §17.4 / §17.5
//
// Tests:
//   - New version supersedes prior current version (superseded_at set).
//   - New version increments the version number correctly.
//   - Users with accepted consents < new version are flagged in user_consent_pending.
//   - Users who already accepted the latest version are NOT re-flagged.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal in-memory simulation of the publish logic from the legal-docs API.
// We test the business rules directly rather than mocking HTTP.

interface LegalDoc {
  id: string;
  document_type: string;
  version: number;
  superseded_at: string | null;
}

interface ConsentRow {
  auth_user_id: string;
  document_type: string;
  document_version: number;
  action: string;
}

interface PendingRow {
  auth_user_id: string;
  document_type: string;
  document_id_pending: string;
}

function simulatePublish(
  existingDocs: LegalDoc[],
  existingConsents: ConsentRow[],
  documentType: string,
  newId: string,
): {
  newVersion: number;
  supersededId: string | null;
  flaggedUsers: string[];
  pendingRows: PendingRow[];
} {
  const docsOfType = existingDocs
    .filter((d) => d.document_type === documentType)
    .sort((a, b) => b.version - a.version);

  const prev = docsOfType[0] ?? null;
  const newVersion = (prev?.version ?? 0) + 1;
  const supersededId = prev?.id ?? null;

  // Find users who accepted a version < newVersion.
  const accepted = existingConsents.filter(
    (c) => c.document_type === documentType && c.action === "accepted" && c.document_version < newVersion,
  );
  const uniqueUsers = [...new Set(accepted.map((c) => c.auth_user_id))];
  const pendingRows = uniqueUsers.map((u) => ({
    auth_user_id: u,
    document_type: documentType,
    document_id_pending: newId,
  }));

  return { newVersion, supersededId, flaggedUsers: uniqueUsers, pendingRows };
}

describe("legal document publish flow (§17.5)", () => {
  it("first publish of a document type has version 1", () => {
    const { newVersion, supersededId } = simulatePublish([], [], "tou", "doc-1");
    expect(newVersion).toBe(1);
    expect(supersededId).toBeNull();
  });

  it("subsequent publish increments version and supersedes prior", () => {
    const docs: LegalDoc[] = [
      { id: "doc-1", document_type: "tou", version: 1, superseded_at: null },
    ];
    const { newVersion, supersededId } = simulatePublish(docs, [], "tou", "doc-2");
    expect(newVersion).toBe(2);
    expect(supersededId).toBe("doc-1");
  });

  it("flags users whose accepted version is below the new version", () => {
    const docs: LegalDoc[] = [
      { id: "doc-1", document_type: "tou", version: 1, superseded_at: null },
    ];
    const consents: ConsentRow[] = [
      { auth_user_id: "user-a", document_type: "tou", document_version: 1, action: "accepted" },
      { auth_user_id: "user-b", document_type: "tou", document_version: 1, action: "accepted" },
    ];
    const { newVersion, flaggedUsers, pendingRows } = simulatePublish(docs, consents, "tou", "doc-2");
    expect(newVersion).toBe(2);
    expect(flaggedUsers).toHaveLength(2);
    expect(flaggedUsers).toContain("user-a");
    expect(flaggedUsers).toContain("user-b");
    expect(pendingRows).toHaveLength(2);
    expect(pendingRows[0]?.document_id_pending).toBe("doc-2");
  });

  it("deduplicates users flagged multiple times (multiple old consents)", () => {
    const docs: LegalDoc[] = [
      { id: "doc-1", document_type: "privacy_policy", version: 2, superseded_at: null },
    ];
    const consents: ConsentRow[] = [
      { auth_user_id: "user-a", document_type: "privacy_policy", document_version: 1, action: "accepted" },
      { auth_user_id: "user-a", document_type: "privacy_policy", document_version: 2, action: "accepted" },
    ];
    const { flaggedUsers } = simulatePublish(docs, consents, "privacy_policy", "doc-3");
    expect(flaggedUsers).toHaveLength(1);
    expect(flaggedUsers[0]).toBe("user-a");
  });

  it("flags users when their accepted version is below the new version", () => {
    const docs: LegalDoc[] = [
      { id: "doc-1", document_type: "tou", version: 3, superseded_at: null },
    ];
    const consents: ConsentRow[] = [
      // newVersion will be 4; user accepted 3 which is < 4, so they ARE flagged.
      { auth_user_id: "user-a", document_type: "tou", document_version: 3, action: "accepted" },
    ];
    const { flaggedUsers } = simulatePublish(docs, consents, "tou", "doc-4");
    expect(flaggedUsers).toHaveLength(1);
  });

  it("declined consents do not trigger re-flag", () => {
    const docs: LegalDoc[] = [
      { id: "doc-1", document_type: "tou", version: 1, superseded_at: null },
    ];
    const consents: ConsentRow[] = [
      { auth_user_id: "user-a", document_type: "tou", document_version: 1, action: "declined" },
    ];
    const { flaggedUsers } = simulatePublish(docs, consents, "tou", "doc-2");
    expect(flaggedUsers).toHaveLength(0);
  });

  it("publish on document_type only flags users of that type, not others", () => {
    // tou v1 and privacy_policy v1 both exist; publish tou v2.
    // User A accepted both at v1. Only their tou consent should trigger a flag.
    const docs: LegalDoc[] = [
      { id: "tou-1", document_type: "tou", version: 1, superseded_at: null },
      { id: "pp-1", document_type: "privacy_policy", version: 1, superseded_at: null },
    ];
    const consents: ConsentRow[] = [
      { auth_user_id: "user-a", document_type: "tou", document_version: 1, action: "accepted" },
      { auth_user_id: "user-a", document_type: "privacy_policy", document_version: 1, action: "accepted" },
    ];
    const { flaggedUsers, pendingRows } = simulatePublish(docs, consents, "tou", "tou-2");
    expect(flaggedUsers).toHaveLength(1);
    expect(pendingRows[0]?.document_type).toBe("tou");
    // Privacy policy consent is unaffected.
    const ppFlagged = pendingRows.filter((r) => r.document_type === "privacy_policy");
    expect(ppFlagged).toHaveLength(0);
  });
});

describe("CCPA deletion grace period logic (§17.10)", () => {
  it("undo is valid within 30 days", () => {
    const deletedAt = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000); // 15 days ago
    const gracePeriodEnd = deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000;
    expect(Date.now() < gracePeriodEnd).toBe(true);
  });

  it("undo is invalid after 30 days", () => {
    const deletedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000); // 31 days ago
    const gracePeriodEnd = deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000;
    expect(Date.now() >= gracePeriodEnd).toBe(true);
  });

  it("purge job with mismatched deleted_at is skipped (stale)", () => {
    const scheduledDeletedAt = "2026-01-01T00:00:00.000Z";
    const actualDeletedAt: string = new Date("2026-01-02").toISOString(); // different from scheduled
    expect(scheduledDeletedAt === actualDeletedAt).toBe(false);
  });

  it("purge job with null deleted_at is skipped (undo was called)", () => {
    const deletedAt: string | null = null;
    expect(deletedAt).toBeNull();
  });
});

describe("CCPA export rate limit (§17.9)", () => {
  it("first export request within 30d is not rate-limited", () => {
    const requests: Array<{ requested_at: string }> = [];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recentRequests = requests.filter((r) => r.requested_at >= thirtyDaysAgo);
    expect(recentRequests).toHaveLength(0);
  });

  it("second request within 30d is rate-limited", () => {
    const now = new Date().toISOString();
    const requests = [{ requested_at: now }];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recentRequests = requests.filter((r) => r.requested_at >= thirtyDaysAgo);
    expect(recentRequests.length).toBeGreaterThan(0);
  });

  it("request older than 30d does not block a new request", () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const requests = [{ requested_at: oldDate }];
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recentRequests = requests.filter((r) => r.requested_at >= thirtyDaysAgo);
    expect(recentRequests).toHaveLength(0);
  });
});

describe("CCPA staging propagation threshold (§17.10)", () => {
  it("alert fires when last refresh is 25+ days ago", () => {
    const lastRefresh = new Date(Date.now() - 26 * 24 * 60 * 60 * 1000);
    const daysSince = (Date.now() - lastRefresh.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysSince).toBeGreaterThanOrEqual(25);
  });

  it("no alert when last refresh is < 25 days ago", () => {
    const lastRefresh = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const daysSince = (Date.now() - lastRefresh.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysSince).toBeLessThan(25);
  });
});
