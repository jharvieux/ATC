import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ publishTenantEvent: vi.fn() }));
vi.mock("@/lib/rag-sync/publish-tenant-event", () => ({
  publishTenantEvent: mocks.publishTenantEvent,
}));

import { activateTenant } from "@/lib/tenants/activate-tenant";

type FakeError = { message: string; code: string; hint: null; details: null; name: string };
type FakeResult = { data: unknown; error: FakeError | null };

/** Minimal thenable Supabase chain. Every builder method returns the same chain object. */
function makeDb(result: FakeResult) {
  const prom = Promise.resolve(result);
  const updateSpy = vi.fn((..._a: unknown[]) => chain);
  const eqSpy = vi.fn((..._a: unknown[]) => chain);
  const selectSpy = vi.fn((..._a: unknown[]) => chain);
  const singleSpy = vi.fn((..._a: unknown[]) => chain);
  // eslint-disable-next-line prefer-const
  const chain = {
    update: updateSpy,
    eq: eqSpy,
    select: selectSpy,
    single: singleSpy,
    then: prom.then.bind(prom),
    catch: prom.catch.bind(prom),
    finally: prom.finally.bind(prom),
  };
  const db = { from: vi.fn(() => chain) } as unknown as SupabaseClient;
  return { db, updateSpy, eqSpy, selectSpy, singleSpy };
}

const ROW = { tenant_type: "byo_host", display_name: "Lisa Travel" };

beforeEach(() => {
  mocks.publishTenantEvent.mockReset();
  mocks.publishTenantEvent.mockResolvedValue(undefined);
});

describe("activateTenant", () => {
  it("writes the base activation fields (incl. source_revision) without CAS on success", async () => {
    const { db, updateSpy, selectSpy, singleSpy } = makeDb({ data: ROW, error: null });
    await activateTenant(db, "tenant-1");
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        onboarding_stage: "complete",
        activated_at: expect.any(String),
        source_revision: expect.any(Number),
      }),
    );
    // Non-CAS now reads the row back (tenant_type/display_name feed the event).
    expect(selectSpy).toHaveBeenCalledWith("tenant_type, display_name");
    expect(singleSpy).toHaveBeenCalled();
  });

  it("merges extra fields into the update payload", async () => {
    const { db, updateSpy } = makeDb({ data: ROW, error: null });
    await activateTenant(db, "tenant-1", {
      review_decision: "approved",
      review_decided_by_user_id: "admin-99",
    });
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        onboarding_stage: "complete",
        review_decision: "approved",
        review_decided_by_user_id: "admin-99",
      }),
    );
  });

  it("CAS path resolves when the stage guard matches — concurrent activation attempt cannot bypass it", async () => {
    const { db, eqSpy, selectSpy } = makeDb({ data: [ROW], error: null });
    await expect(activateTenant(db, "tenant-1", {}, { casStage: "branding" })).resolves.toBeUndefined();
    expect(eqSpy).toHaveBeenCalledWith("onboarding_stage", "branding");
    expect(selectSpy).toHaveBeenCalledWith("tenant_type, display_name");
  });

  it("throws ROW_COUNT_MISMATCH when CAS guard finds zero rows (double-activation guard)", async () => {
    const { db } = makeDb({ data: [], error: null });
    await expect(activateTenant(db, "tenant-1", {}, { casStage: "branding" })).rejects.toMatchObject({
      code: "ROW_COUNT_MISMATCH",
    });
    // Failed activation must not announce a status change to RAG.
    expect(mocks.publishTenantEvent).not.toHaveBeenCalled();
  });

  it("throws SupabaseMutationError on DB error", async () => {
    const { db } = makeDb({
      data: null,
      error: { message: "connection refused", code: "08006", hint: null, details: null, name: "PostgrestError" },
    });
    await expect(activateTenant(db, "tenant-1")).rejects.toMatchObject({
      name: "SupabaseMutationError",
      context: "tenants.update.activate",
    });
    expect(mocks.publishTenantEvent).not.toHaveBeenCalled();
  });

  it("emits tenant.status_changed to RAG with an active payload and a monotonic revision matching the row write", async () => {
    const { db, updateSpy } = makeDb({ data: ROW, error: null });
    await activateTenant(db, "tenant-1");

    expect(mocks.publishTenantEvent).toHaveBeenCalledTimes(1);
    const event = mocks.publishTenantEvent.mock.calls[0]![0];
    expect(event).toMatchObject({
      event_type: "tenant.status_changed",
      tenant_id: "tenant-1",
      payload: { status: "active", tenant_type: "byo_host", display_name: "Lisa Travel" },
    });
    // Revision must clear the RAG stale-guard (signup sent 0) — epoch-seconds.
    expect(event.source_revision).toBeGreaterThan(1_700_000_000);
    // The revision persisted to tenants must equal the one announced, so the
    // nightly reconcile sees no spurious drift.
    const writtenFields = updateSpy.mock.calls[0]![0] as { source_revision: number };
    expect(writtenFields.source_revision).toBe(event.source_revision);
  });
});
