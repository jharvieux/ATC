// §8.7 (#1609) — publishTenantEvent now enqueues to Inngest (rag-sync-deliver
// owns delivery). Intent under test:
//   1. It enqueues a rag-sync/tenant.event carrying the event verbatim, under a
//      DETERMINISTIC id derived from (tenant_id, event_type, source_revision) so
//      a double-enqueue dedups to one delivery — the idempotency contract.
//   2. It never throws: callers commit the lifecycle row first and must not roll
//      back if Inngest is briefly unreachable (an enqueue failure is alerted).

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(async (_send: unknown) => ({ ids: ["evt_1"] })),
  alert: vi.fn(async (_input: unknown) => undefined),
}));
vi.mock("@/inngest/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/lib/monitoring/send-operator-alert", () => ({ sendOperatorAlert: mocks.alert }));

import { publishTenantEvent, type TenantEvent } from "@/lib/rag-sync/publish-tenant-event";

const EVENT: TenantEvent = {
  event_type: "tenant.status_changed",
  tenant_id: "11111111-1111-1111-1111-111111111111",
  source_revision: 1_780_000_000,
  payload: { status: "active", tenant_type: "byo_host", display_name: "Lisa Travel" },
};

beforeEach(() => {
  mocks.send.mockClear();
  mocks.send.mockResolvedValue({ ids: ["evt_1"] });
  mocks.alert.mockClear();
});

describe("publishTenantEvent", () => {
  it("enqueues rag-sync/tenant.event with the event and a deterministic dedup id", async () => {
    await publishTenantEvent(EVENT);

    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send).toHaveBeenCalledWith({
      // Deterministic id: re-enqueuing the same event dedups to one delivery.
      id: `rag-sync:tenant:${EVENT.tenant_id}:tenant.status_changed:${EVENT.source_revision}`,
      name: "rag-sync/tenant.event",
      data: { event: EVENT },
    });
  });

  it("never throws when the enqueue fails — the committed lifecycle op must not roll back", async () => {
    mocks.send.mockRejectedValueOnce(new Error("inngest unreachable"));

    await expect(publishTenantEvent(EVENT)).resolves.toBeUndefined();
    // Not silently dropped — an operator alert fires so the drop is visible;
    // the nightly reconcile heals the shadow.
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.alert.mock.calls[0]![0]).toMatchObject({ signal: "rag_sync_enqueue_failed" });
  });
});
