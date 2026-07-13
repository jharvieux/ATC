// BP37 §37.10 — sequence-engine enforces the assertSequencesAvailable tier gate
// in its firing path. byo_research must never get auto-fired sequences.

import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/inngest/client", () => ({ inngest: { send } }));

import { triggerMatchingSequences } from "@/lib/tasks/sequence-engine";

type TierRow = { tier_definitions: { code: string } | null };

// Minimal Supabase-shaped stub: tierCode reads tenants; the rest of the
// engine reads task_sequences/steps/runs. We record which tables were hit
// so a blocked tier can be shown to short-circuit before any sequence lookup.
function makeSvc(tierCode: string | null) {
  const tablesHit: string[] = [];
  const svc = {
    from(table: string) {
      tablesHit.push(table);
      if (table === "tenants") {
        const row: TierRow = { tier_definitions: tierCode ? { code: tierCode } : null };
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        };
      }
      if (table === "task_sequences") {
        // No active sequences — engine returns 0 runs for allowed tiers.
        return {
          select: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ data: [], error: null }) }) }) }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  return { svc: svc as never, tablesHit };
}

describe("triggerMatchingSequences tier gate (§37.10)", () => {
  beforeEach(() => send.mockClear());

  it("blocks byo_research: no sequence lookup, no runs, no Inngest emit", async () => {
    const { svc, tablesHit } = makeSvc("byo_research");
    const res = await triggerMatchingSequences({
      tenant_id: "t1",
      trigger: "booking_confirmed",
      record: { booking_id: "b1" },
      svc,
    });
    expect(res).toEqual({ runs_started: 0 });
    expect(tablesHit).toContain("tenants");
    expect(tablesHit).not.toContain("task_sequences");
    expect(send).not.toHaveBeenCalled();
  });

  it("allows a non-blocked tier through to the sequence lookup", async () => {
    const { svc, tablesHit } = makeSvc("byo_agency");
    const res = await triggerMatchingSequences({
      tenant_id: "t1",
      trigger: "booking_confirmed",
      record: { booking_id: "b1" },
      svc,
    });
    expect(res).toEqual({ runs_started: 0 });
    expect(tablesHit).toContain("task_sequences");
  });
});
