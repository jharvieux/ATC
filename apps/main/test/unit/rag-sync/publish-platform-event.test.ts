// D-041 follow-up / §8.7 (#1609) — publish-platform-event tests.
//
// Behaviour under test (contract):
//   1. isSyncEligibleKey returns true ONLY for keys the rag side consumes.
//      A regression here would either leak non-sync keys (privacy concern
//      for the deny-list) or silently drop legitimate keys.
//   2. The publisher filters non-eligible keys out of the enqueued payload,
//      logging which keys were dropped.
//   3. An event whose entire change set is non-eligible short-circuits to a
//      no-op (nothing enqueued).
//   4. Delivery itself moved to Inngest (rag-sync-deliver) — the publisher only
//      enqueues; the deny-list value must never reach the enqueued body.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (_send: unknown) => ({ ids: ["evt_1"] })),
  alert: vi.fn(async (_input: unknown) => undefined),
}));
vi.mock("@/inngest/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/lib/monitoring/send-operator-alert", () => ({ sendOperatorAlert: mocks.alert }));

import { isSyncEligibleKey, publishPlatformEvent } from "@/lib/rag-sync/publish-platform-event";

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
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mocks.send.mockClear();
    mocks.alert.mockClear();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("short-circuits when every change is non-eligible (nothing enqueued)", async () => {
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
    expect(mocks.send).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled(); // warned about the dropped keys
  });

  it("filters non-eligible keys but still enqueues eligible ones — deny-list value never leaks", async () => {
    await publishPlatformEvent({
      event_type: "platform_settings.updated",
      source_revision: 12345,
      payload: {
        changes: [
          { key: "supervisor_slur_deny_list", value: ["badword"] }, // dropped
          { key: "feedback_adjustment_limit", value: 0.1 }, // kept
          { key: "feedback_period_days", value: 14 }, // kept
        ],
      },
    });

    expect(mocks.send).toHaveBeenCalledTimes(1);
    const arg = mocks.send.mock.calls[0]![0] as {
      name: string;
      data: { event: { payload: { changes: Array<{ key: string }> } } };
    };
    expect(arg.name).toBe("rag-sync/platform.event");
    expect(arg.data.event.payload.changes.map((c) => c.key).sort()).toEqual([
      "feedback_adjustment_limit",
      "feedback_period_days",
    ]);
    const serialized = JSON.stringify(arg);
    expect(serialized).not.toContain("badword");
    expect(serialized).not.toContain("supervisor_slur_deny_list");
  });

  it("enqueues unfiltered when every change is eligible", async () => {
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
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const arg = mocks.send.mock.calls[0]![0] as {
      data: { event: { payload: { changes: unknown[] } } };
    };
    expect(arg.data.event.payload.changes).toHaveLength(2);
  });

  it("never throws when the enqueue fails (committed platform_settings write must not roll back)", async () => {
    mocks.send.mockRejectedValueOnce(new Error("inngest unreachable"));
    await expect(
      publishPlatformEvent({
        event_type: "platform_settings.updated",
        source_revision: 12345,
        payload: { changes: [{ key: "feedback_adjustment_limit", value: 0.1 }] },
      }),
    ).resolves.toBeUndefined();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert.mock.calls[0]![0]).toMatchObject({ signal: "rag_sync_enqueue_failed" });
  });
});
