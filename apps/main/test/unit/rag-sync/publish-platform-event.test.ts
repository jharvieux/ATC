// D-041 follow-up — publish-platform-event tests.
//
// Behaviour under test (contract):
//   1. isSyncEligibleKey returns true ONLY for keys the rag side consumes.
//      A regression here would either leak non-sync keys (privacy concern
//      for the deny-list) or silently drop legitimate keys.
//   2. The sender filters non-eligible keys out of the payload, logging
//      which keys were dropped.
//   3. An event whose entire change set is non-eligible short-circuits to
//      a no-op (no fetch, no queue insert).
//
// The actual fetch/retry/queue logic mirrors publishTenantEvent (already
// exercised in production) — not duplicating those tests here. The new
// behaviour worth testing is the allowlist filter.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mocks = vi.hoisted(() => ({
  insert: vi.fn(() => ({ data: null, error: null })),
  from: vi.fn(),
}));
mocks.from.mockImplementation(() => ({ insert: mocks.insert }));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({ from: mocks.from }),
}));

import { isSyncEligibleKey, publishPlatformEvent } from "../../../src/lib/rag-sync/publish-platform-event";

describe("isSyncEligibleKey", () => {
  it("returns true for feedback knobs", () => {
    expect(isSyncEligibleKey("feedback_adjustment_limit")).toBe(true);
    expect(isSyncEligibleKey("feedback_min_signal_count")).toBe(true);
    expect(isSyncEligibleKey("feedback_period_days")).toBe(true);
    expect(isSyncEligibleKey("feedback_decay_halflife_days")).toBe(true);
  });

  it("returns false for the deny-list (privacy)", () => {
    expect(isSyncEligibleKey("supervisor_slur_deny_list")).toBe(false);
  });

  it("returns false for arbitrary unknown keys", () => {
    expect(isSyncEligibleKey("anything_else")).toBe(false);
    expect(isSyncEligibleKey("customer_chat_soft1_cap")).toBe(false);
  });
});

describe("publishPlatformEvent — allowlist filter", () => {
  const ORIGINAL_ENV = { ...process.env };
  let fetchMock: Mock;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warnSpy: any;

  beforeEach(() => {
    process.env.RAG_SERVICE_URL = "https://rag.example.com";
    process.env.RAG_WEBHOOK_SECRET = "test-secret";
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ applied: [], skipped: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.from.mockClear();
    mocks.insert.mockClear();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    warnSpy?.mockRestore();
  });

  it("short-circuits when every change is non-eligible (no fetch fired)", async () => {
    await publishPlatformEvent({
      event_type: "platform_settings.updated",
      source_revision: 12345,
      payload: {
        changes: [
          { key: "supervisor_slur_deny_list", value: ["badword"] },
          { key: "some_other_unsynced_key", value: 42 },
        ],
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    // Warned about the dropped keys.
    expect(warnSpy).toHaveBeenCalled();
  });

  it("filters non-eligible keys but still publishes eligible ones", async () => {
    await publishPlatformEvent({
      event_type: "platform_settings.updated",
      source_revision: 12345,
      payload: {
        changes: [
          { key: "supervisor_slur_deny_list", value: ["badword"] },         // dropped
          { key: "feedback_adjustment_limit", value: 0.1 },                  // kept
          { key: "feedback_period_days", value: 14 },                        // kept
        ],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    const [url, options] = call as [string, RequestInit];
    expect(url).toBe("https://rag.example.com/api/platform-settings-events");

    const body = JSON.parse(options.body as string);
    expect(body.payload.changes.map((c: { key: string }) => c.key).sort()).toEqual([
      "feedback_adjustment_limit",
      "feedback_period_days",
    ]);
    // The deny-list value never made it into the outbound body.
    expect(options.body).not.toContain("badword");
    expect(options.body).not.toContain("supervisor_slur_deny_list");
  });

  it("publishes unfiltered when every change is eligible", async () => {
    await publishPlatformEvent({
      event_type: "platform_settings.updated",
      source_revision: 12345,
      payload: {
        changes: [
          { key: "feedback_adjustment_limit", value: 0.1 },
          { key: "feedback_decay_halflife_days", value: 60 },
        ],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.payload.changes).toHaveLength(2);
  });

  it("queues eligible keys to pending_rag_sync when RAG_SERVICE_URL is not set (#1595)", async () => {
    delete process.env.RAG_SERVICE_URL;
    await publishPlatformEvent({
      event_type: "platform_settings.updated",
      source_revision: 12345,
      payload: {
        changes: [
          { key: "feedback_adjustment_limit", value: 0.1 }, // eligible → queued
          { key: "supervisor_slur_deny_list", value: ["x"] }, // ineligible → filtered out
        ],
      },
    });
    // Missing config must NOT silently drop the event (the old behaviour) — it
    // queues for the retry cron, exactly like publishTenantEvent. tenant_id is
    // NULL for platform-scope events; only the eligible key survives filtering.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.from).toHaveBeenCalledWith("pending_rag_sync");
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: null,
        event_type: "platform_settings.updated",
        source_revision: 12345,
        last_error: "RAG_SERVICE_URL or RAG_WEBHOOK_SECRET not set",
        // Only the eligible key survives filtering into the queued payload.
        payload: { changes: [{ key: "feedback_adjustment_limit", value: 0.1 }] },
      }),
    );
  });

  it("short-circuits with no queue when every change is non-eligible and config is missing", async () => {
    delete process.env.RAG_SERVICE_URL;
    await publishPlatformEvent({
      event_type: "platform_settings.updated",
      source_revision: 12345,
      payload: { changes: [{ key: "supervisor_slur_deny_list", value: ["x"] }] },
    });
    // Nothing eligible → nothing to sync → no fetch and no queue row.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
