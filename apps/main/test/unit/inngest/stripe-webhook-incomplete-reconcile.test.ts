// [review gap-fill for #719] The stripe-webhook-incomplete-reconcile cron was
// alert-only. #719 asks it to also delete/reset stalled rows so they don't
// accumulate and so a Stripe re-delivery can re-insert + reprocess. These tests
// pin that: stalled rows are alerted AND cleared, with the clear failing loud.

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  alert: vi.fn(async () => undefined),
  selectResult: { data: [] as Array<Record<string, unknown>>, error: null as { message: string } | null },
  deleteResult: { error: null as { message: string } | null },
  deletedIn: [] as unknown[][],
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({
    from() {
      return {
        select() {
          const chain: Record<string, unknown> = {
            lt() { return chain; },
            is() { return chain; },
            then(resolve: (v: unknown) => unknown) { return resolve(mocks.selectResult); },
          };
          return chain;
        },
        delete() {
          return {
            in(_col: string, ids: unknown[]) {
              void _col;
              mocks.deletedIn.push(ids);
              return { then(resolve: (v: unknown) => unknown) { return resolve(mocks.deleteResult); } };
            },
          };
        },
      };
    },
  }),
}));
vi.mock("@/lib/monitoring/send-operator-alert", () => ({ sendOperatorAlert: mocks.alert }));
vi.mock("@/inngest/client", () => ({
  inngest: { createFunction: (config: unknown, handler: unknown) => ({ config, handler }) },
}));

import { stripeWebhookIncompleteReconcile } from "@/inngest/stripe-webhook-incomplete-reconcile";

const fn = stripeWebhookIncompleteReconcile as unknown as { handler: () => Promise<unknown> };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectResult = { data: [], error: null };
  mocks.deleteResult = { error: null };
  mocks.deletedIn = [];
});

describe("stripe-webhook-incomplete-reconcile cron", () => {
  it("no stalled rows: no alert, no delete", async () => {
    const r = await fn.handler();
    expect(r).toEqual({ stalled: 0 });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.deletedIn).toHaveLength(0);
  });

  it("[review gap-fill #719] stalled rows: alerts AND clears exactly the stalled ids (was alert-only)", async () => {
    mocks.selectResult = {
      data: [
        { id: "r1", stripe_event_id: "evt_1", event_type: "transfer.reversed", processing_started_at: "2026-06-07T00:00:00Z" },
        { id: "r2", stripe_event_id: "evt_2", event_type: "customer.subscription.updated", processing_started_at: "2026-06-07T00:00:00Z" },
      ],
      error: null,
    };
    const r = await fn.handler();
    expect(mocks.alert).toHaveBeenCalledTimes(1);
    expect(mocks.deletedIn).toEqual([["r1", "r2"]]); // cleared exactly the stalled rows
    expect(r).toEqual({ stalled: 2, cleared: 2 });
  });

  it("throws (fail-loud) if clearing the stalled rows errors — does not silently leave zombies", async () => {
    mocks.selectResult = {
      data: [{ id: "r1", stripe_event_id: "evt_1", event_type: "transfer.reversed", processing_started_at: "2026-06-07T00:00:00Z" }],
      error: null,
    };
    mocks.deleteResult = { error: { message: "db unavailable" } };
    await expect(fn.handler()).rejects.toThrow(/db unavailable/);
    expect(mocks.alert).toHaveBeenCalledTimes(1); // alert still fires before the clear
  });
});
