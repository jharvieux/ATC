import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { activateTenant } from "@/lib/tenants/activate-tenant";

type FakeError = { message: string; code: string; hint: null; details: null; name: string };
type FakeResult = { data: unknown; error: FakeError | null };

/** Minimal thenable Supabase chain. Every builder method returns the same chain object. */
function makeDb(result: FakeResult) {
  const prom = Promise.resolve(result);
  const updateSpy = vi.fn(() => chain);
  const eqSpy = vi.fn(() => chain);
  const selectSpy = vi.fn(() => chain);
  // eslint-disable-next-line prefer-const
  const chain = {
    update: updateSpy,
    eq: eqSpy,
    select: selectSpy,
    then: prom.then.bind(prom),
    catch: prom.catch.bind(prom),
    finally: prom.finally.bind(prom),
  };
  const db = { from: vi.fn(() => chain) } as unknown as SupabaseClient;
  return { db, updateSpy, eqSpy, selectSpy };
}

describe("activateTenant", () => {
  it("writes the three base activation fields without CAS on success", async () => {
    const { db, updateSpy, selectSpy } = makeDb({ data: null, error: null });
    await activateTenant(db, "tenant-1");
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "active",
        onboarding_stage: "complete",
        activated_at: expect.any(String),
      }),
    );
    // No CAS — select("id") must not be called
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("merges extra fields into the update payload", async () => {
    const { db, updateSpy } = makeDb({ data: null, error: null });
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
    const { db, eqSpy, selectSpy } = makeDb({ data: [{ id: "tenant-1" }], error: null });
    await expect(activateTenant(db, "tenant-1", {}, { casStage: "branding" })).resolves.toBeUndefined();
    expect(eqSpy).toHaveBeenCalledWith("onboarding_stage", "branding");
    expect(selectSpy).toHaveBeenCalledWith("id");
  });

  it("throws ROW_COUNT_MISMATCH when CAS guard finds zero rows (double-activation guard)", async () => {
    const { db } = makeDb({ data: [], error: null });
    await expect(activateTenant(db, "tenant-1", {}, { casStage: "branding" })).rejects.toMatchObject({
      code: "ROW_COUNT_MISMATCH",
    });
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
  });
});
