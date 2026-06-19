import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ publishTenantEvent: vi.fn() }));
vi.mock("@/lib/rag-sync/publish-tenant-event", () => ({
  publishTenantEvent: mocks.publishTenantEvent,
}));

import { publishTenantShadowEvent } from "@/lib/rag-sync/publish-tenant-shadow-event";

type FakeResult = { data: unknown; error: unknown };

// Thenable Supabase chain ending in .select().single().
function makeDb(result: FakeResult) {
  const prom = Promise.resolve(result);
  const updateSpy = vi.fn((..._a: unknown[]) => chain);
  // eslint-disable-next-line prefer-const
  const chain: Record<string, unknown> = {
    update: updateSpy,
    eq: vi.fn((..._a: unknown[]) => chain),
    select: vi.fn((..._a: unknown[]) => chain),
    single: vi.fn((..._a: unknown[]) => chain),
    then: prom.then.bind(prom),
    catch: prom.catch.bind(prom),
    finally: prom.finally.bind(prom),
  };
  const db = { from: vi.fn(() => chain) } as unknown as SupabaseClient;
  return { db, updateSpy };
}

const ROW = { status: "terminated", tenant_type: "byo_host", display_name: "Lisa Travel" };

beforeEach(() => {
  mocks.publishTenantEvent.mockReset();
  mocks.publishTenantEvent.mockResolvedValue(undefined);
});

describe("publishTenantShadowEvent", () => {
  it("emits the given event type with the canonical row and a monotonic revision matching the write", async () => {
    const { db, updateSpy } = makeDb({ data: ROW, error: null });

    await publishTenantShadowEvent(db, "tenant-1", "tenant.terminated");

    expect(mocks.publishTenantEvent).toHaveBeenCalledTimes(1);
    const event = mocks.publishTenantEvent.mock.calls[0]![0];
    expect(event).toMatchObject({
      event_type: "tenant.terminated",
      tenant_id: "tenant-1",
      payload: { status: "terminated", tenant_type: "byo_host", display_name: "Lisa Travel" },
    });
    expect(event.source_revision).toBeGreaterThan(1_700_000_000);
    const written = updateSpy.mock.calls[0]![0] as { source_revision: number };
    expect(written.source_revision).toBe(event.source_revision);
  });

  it("relays the event type verbatim (status_changed / metadata_updated), reading status from the row", async () => {
    const { db } = makeDb({ data: { status: "suspended", tenant_type: "agency", display_name: "Acme" }, error: null });
    await publishTenantShadowEvent(db, "t2", "tenant.status_changed");
    expect(mocks.publishTenantEvent.mock.calls[0]![0]).toMatchObject({
      event_type: "tenant.status_changed",
      payload: { status: "suspended", tenant_type: "agency", display_name: "Acme" },
    });
  });

  it("is best-effort: a failed revision bump is swallowed and no event is emitted (reconcile backstops)", async () => {
    const { db } = makeDb({
      data: null,
      error: { message: "deadlock", code: "40P01", hint: null, details: null, name: "PostgrestError" },
    });

    // Must not throw — the primary lifecycle op already committed.
    await expect(publishTenantShadowEvent(db, "tenant-1", "tenant.terminated")).resolves.toBeUndefined();
    expect(mocks.publishTenantEvent).not.toHaveBeenCalled();
  });
});
