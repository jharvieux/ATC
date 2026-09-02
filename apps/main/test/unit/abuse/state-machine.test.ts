// #2112 — state decisions are serialized in the database and their outbox
// rows dispatch with deterministic identities so a crash/retry converges.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedThresholds } from "@/lib/abuse/thresholds";

const THRESHOLDS: ResolvedThresholds = {
  ai_cost_cents: { soft1: 100n, soft2: 200n, hard: 300n },
  chat_volume_messages_monthly: { soft1: 10, soft2: 20, hard: 30 },
  email_volume_daily: { soft1: 5, soft2: 10, hard: 15 },
  group_invite_monthly: { soft1: 50, soft2: 100, hard: 200, per_group_max: 100 },
  rag_cap_total: { base: 50, effective: 60, approaching: 45 },
  help_submission_rate_daily: { soft1: 20, soft2: 50, hard: 100 },
  effective_monthly_revenue_cents: 14900n,
};

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  safeAwait: vi.fn(),
  send: vi.fn(),
  updatePayloads: [] as unknown[],
}));

vi.mock("@/lib/abuse/thresholds", () => ({
  resolveThresholds: async () => THRESHOLDS,
}));

vi.mock("@/inngest/client", () => ({
  inngest: { send: mocks.send },
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: mocks.safeAwait,
}));

import {
  checkStateTransitionIfNeeded,
  dispatchPendingTransitionOutbox,
  recoverPendingStateEvaluations,
} from "@/lib/abuse/state-machine";

const TENANT = {
  tenant_id: "00000000-0000-0000-0000-000000000111",
  tier_code: "sub_pro" as const,
  seat_count: 1,
  billing_period: "monthly" as const,
};

function makeBuilder() {
  const builder: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) builder[method] = () => builder;
  builder.update = (payload: unknown) => {
    mocks.updatePayloads.push(payload);
    return builder;
  };
  return builder;
}

function makeDb() {
  return {
    rpc: mocks.rpc,
    from: () => makeBuilder(),
  } as never;
}

const OUTBOX_ROW = {
  event_id: "00000000-0000-0000-0000-000000000222",
  event_tenant_id: TENANT.tenant_id,
  event_dimension: "chat_volume",
  event_from_state: "ok",
  event_to_state: "soft1",
  event_metric_value: "10",
  event_threshold_crossed: "10",
  event_created: true,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updatePayloads = [];
  mocks.rpc.mockReturnValue(Promise.resolve({ data: null, error: null }));
  mocks.send.mockResolvedValue(undefined);
  mocks.safeAwait.mockImplementation(async (_query: unknown, label: string) => {
    if (label.endsWith("rpc.advance_state")) return [OUTBOX_ROW];
    return null;
  });
});

describe("monthly transition RPC", () => {
  it("passes resolved thresholds and permits a subscription downgrade only when requested", async () => {
    const created = await checkStateTransitionIfNeeded({
      db: makeDb(),
      tenant: TENANT,
      dimension: "chat_volume",
      allow_downgrade: true,
      reason: "subscription_change_recompute",
    });

    expect(created).toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("advance_tenant_usage_state", expect.objectContaining({
      p_tenant_id: TENANT.tenant_id,
      p_dimension: "chat_volume",
      p_soft1: "10",
      p_soft2: "20",
      p_hard: "30",
      p_allow_downgrade: true,
      p_reason: "subscription_change_recompute",
    }));
  });

  it("does not accept a caller-provided metric value", async () => {
    await checkStateTransitionIfNeeded({
      db: makeDb(),
      tenant: TENANT,
      dimension: "ai_cost",
    });

    const args = mocks.rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("p_metric_value");
  });
});

describe("outbox dispatch", () => {
  it("uses the audit row id for Inngest dedup and clears its dispatch marker", async () => {
    await checkStateTransitionIfNeeded({
      db: makeDb(),
      tenant: TENANT,
      dimension: "chat_volume",
    });

    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      id: `abuse-state-transition:${OUTBOX_ROW.event_id}`,
      name: "abuse.state_transition",
      data: expect.objectContaining({ usage_event_id: OUTBOX_ROW.event_id }),
    }));
    expect(mocks.updatePayloads).toContainEqual(expect.objectContaining({
      event_dispatch_pending: false,
    }));
  });

  it("leaves the durable marker pending when dispatch fails", async () => {
    mocks.send.mockRejectedValueOnce(new Error("Inngest unavailable"));

    await expect(checkStateTransitionIfNeeded({
      db: makeDb(),
      tenant: TENANT,
      dimension: "chat_volume",
    })).rejects.toThrow(/Inngest unavailable/);
    expect(mocks.updatePayloads).toHaveLength(0);
  });

  it("bounds multi-row outbox recovery to ten concurrent sends", async () => {
    const pending = Array.from({ length: 12 }, (_, index) => ({
      id: `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`,
      tenant_id: TENANT.tenant_id,
      dimension: "chat_volume",
      from_state: "ok",
      to_state: "soft1",
      metric_value: "10",
      threshold_crossed: "10",
    }));
    mocks.safeAwait.mockImplementation(async (_query: unknown, label: string) => {
      if (label.endsWith("select.dispatch_pending")) {
        return pending;
      }
      return null;
    });
    let active = 0;
    let maxActive = 0;
    mocks.send.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(5);
      active--;
    });

    await expect(dispatchPendingTransitionOutbox(makeDb())).resolves.toBe(12);
    expect(mocks.send).toHaveBeenCalledTimes(12);
    expect(maxActive).toBe(10);
  });

  it("fails outbox recovery loudly when any pending dispatch fails", async () => {
    mocks.safeAwait.mockImplementation(async (_query: unknown, label: string) => {
      if (label.endsWith("select.dispatch_pending")) {
        return [
          { ...OUTBOX_ROW, id: "event-1", tenant_id: TENANT.tenant_id, dimension: "chat_volume", from_state: "ok", to_state: "soft1", metric_value: "10", threshold_crossed: "10" },
          { ...OUTBOX_ROW, id: "event-2", tenant_id: TENANT.tenant_id, dimension: "chat_volume", from_state: "ok", to_state: "soft1", metric_value: "10", threshold_crossed: "10" },
        ];
      }
      return null;
    });
    mocks.send.mockRejectedValueOnce(new Error("dispatch recovery failed"));

    await expect(dispatchPendingTransitionOutbox(makeDb())).rejects.toThrow("dispatch recovery failed");
  });

  it("periodic recovery evaluates a durable counter marker using its original period", async () => {
    mocks.safeAwait.mockImplementation(async (_query: unknown, label: string) => {
      if (label === "usage_limit_state_evaluations.select.pending") {
        return [{
          tenant_id: TENANT.tenant_id,
          dimension: "chat_volume",
          billing_period: "[2026-08-01,2026-09-01)",
        }];
      }
      if (label === "tenants.select.usage_state_recovery") {
        return [{
          id: TENANT.tenant_id,
          tier_id: null,
          seat_count: 1,
          billing_period: "monthly",
        }];
      }
      if (label.endsWith("rpc.advance_state")) return [OUTBOX_ROW];
      return null;
    });

    await expect(recoverPendingStateEvaluations(makeDb())).resolves.toBe(1);
    expect(mocks.rpc).toHaveBeenCalledWith("advance_tenant_usage_state", expect.objectContaining({
      p_billing_period: "[2026-08-01,2026-09-01)",
      p_tenant_id: TENANT.tenant_id,
      p_dimension: "chat_volume",
    }));
  });

  it("passes an email marker's original UTC day to the state RPC", async () => {
    mocks.safeAwait.mockImplementation(async (_query: unknown, label: string) => {
      if (label === "usage_limit_state_evaluations.select.pending") {
        return [{
          tenant_id: TENANT.tenant_id,
          dimension: "email_volume",
          billing_period: "[2026-08-01,2026-09-01)",
          evaluation_day: "2026-08-31",
        }];
      }
      if (label === "tenants.select.usage_state_recovery") {
        return [{
          id: TENANT.tenant_id,
          tier_id: null,
          seat_count: 1,
          billing_period: "monthly",
        }];
      }
      if (label.endsWith("rpc.advance_state")) return [OUTBOX_ROW];
      return null;
    });

    await expect(recoverPendingStateEvaluations(makeDb())).resolves.toBe(1);
    expect(mocks.rpc).toHaveBeenCalledWith("advance_tenant_usage_state", expect.objectContaining({
      p_tenant_id: TENANT.tenant_id,
      p_dimension: "email_volume",
      p_billing_period: "[2026-08-01,2026-09-01)",
      p_evaluation_day: "2026-08-31",
    }));
  });

  it("bounds multi-row state recovery and propagates an evaluation failure", async () => {
    const evaluations = Array.from({ length: 12 }, (_, index) => ({
      tenant_id: `00000000-0000-0000-0001-${String(index).padStart(12, "0")}`,
      dimension: "chat_volume" as const,
      billing_period: "[2026-08-01,2026-09-01)",
    }));
    let active = 0;
    let maxActive = 0;
    let advances = 0;
    mocks.safeAwait.mockImplementation(async (_query: unknown, label: string) => {
      if (label === "usage_limit_state_evaluations.select.pending") return evaluations;
      if (label === "tenants.select.usage_state_recovery") {
        return evaluations.map((row) => ({
          id: row.tenant_id,
          tier_id: null,
          seat_count: 1,
          billing_period: "monthly",
        }));
      }
      if (label.endsWith("rpc.advance_state")) {
        const current = advances++;
        active++;
        maxActive = Math.max(maxActive, active);
        await sleep(5);
        active--;
        if (current === 11) throw new Error("state recovery failed");
        return null;
      }
      return null;
    });

    await expect(recoverPendingStateEvaluations(makeDb())).rejects.toThrow("state recovery failed");
    expect(advances).toBe(12);
    expect(maxActive).toBe(10);
  });
});

it("keeps help_submission_rate on its dedicated daily state machine", async () => {
  await expect(checkStateTransitionIfNeeded({
    db: makeDb(),
    tenant: TENANT,
    dimension: "help_submission_rate",
  })).rejects.toThrow(/help_submission_rate/);
});
