// §27.7 — Abuse state machine: classifyAbuse / classifyRag boundaries +
// monotonic/non-monotonic transition guards.
//
// 18 survived + 121 NoCoverage mutants — this file had 0% coverage.
// Key mutant targets:
//   - >= comparators in classifyAbuse / classifyRag (boundary values)
//   - at_cap vs over_cap distinction (count === effective vs count > effective)
//   - monotonic rank guard (RANK[new] <= RANK[current] → no-op)
//   - non-monotonic RAG (any state change triggers write, including downgrades)
//   - early returns when no metrics/quota row

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedThresholds } from "@/lib/abuse/thresholds";

// ── fixed mock thresholds ──────────────────────────────────────────────────
// Simple round numbers to make boundary assertions unambiguous.

const MOCK_THRESHOLDS: ResolvedThresholds = {
  ai_cost_cents:                 { soft1: 100n, soft2: 200n, hard: 300n },
  chat_volume_messages_monthly:  { soft1: 10, soft2: 20, hard: 30 },
  email_volume_daily:            { soft1: 5, soft2: 10, hard: 15 },
  group_invite_monthly:          { soft1: 50, soft2: 100, hard: 200, per_group_max: 100 },
  rag_cap_total:                 { base: 50, effective: 60, approaching: 45 },
  help_submission_rate_daily:    { soft1: 20, soft2: 50, hard: 100 },
  effective_monthly_revenue_cents: 14900n,
};

// ── mocks ──────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  metricsRow: null as Record<string, unknown> | null,
  ragRow: null as { rag_state: string } | null,
  safeAwaitLabels: [] as string[],
  inngestEvents: [] as unknown[],
}));

vi.mock("@/lib/abuse/thresholds", () => ({
  resolveThresholds: async () => MOCK_THRESHOLDS,
}));

vi.mock("@/inngest/client", () => ({
  inngest: { send: async (e: unknown) => { h.inngestEvents.push(e); } },
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: async (_q: unknown, label: string) => {
    h.safeAwaitLabels.push(label);
    return null;
  },
}));

// DB mock: dispatches maybySingle results based on table name.
function makeDb() {
  function chain(table: string): Record<string, (...args: unknown[]) => unknown> {
    const b: Record<string, (...args: unknown[]) => unknown> = {};
    for (const m of ["select", "eq", "order", "limit", "update", "insert"]) {
      b[m] = () => chain(table);
    }
    b.maybeSingle = () =>
      Promise.resolve({
        data: table === "tenant_rag_quotas" ? h.ragRow : h.metricsRow,
        error: null,
      });
    return b;
  }
  return { from: (t: string) => chain(t) } as never;
}

import { checkStateTransitionIfNeeded } from "@/lib/abuse/state-machine";

const TENANT = {
  tenant_id: "t-1",
  tier_code: "sub_pro" as const,
  seat_count: 1,
  billing_period: "monthly" as const,
};

beforeEach(() => {
  h.metricsRow = null;
  h.ragRow = null;
  h.safeAwaitLabels = [];
  h.inngestEvents = [];
});

// ── programmer guard ───────────────────────────────────────────────────────

describe("checkStateTransitionIfNeeded — help_submission_rate programmer guard", () => {
  it("throws when dimension is help_submission_rate (per-day semantics; wrong state machine)", async () => {
    await expect(
      checkStateTransitionIfNeeded({
        db: makeDb(),
        tenant: TENANT,
        dimension: "help_submission_rate",
        metric_value: 25n,
      }),
    ).rejects.toThrow(/help_submission_rate/);
  });
});

// ── no metrics row — early return ─────────────────────────────────────────

describe("checkStateTransitionIfNeeded — no metrics row (monthly early return)", () => {
  it("returns without writing or firing Inngest when no metrics row exists", async () => {
    h.metricsRow = null;
    await checkStateTransitionIfNeeded({
      db: makeDb(),
      tenant: TENANT,
      dimension: "chat_volume",
      metric_value: 9999n,
    });
    expect(h.safeAwaitLabels).toHaveLength(0);
    expect(h.inngestEvents).toHaveLength(0);
  });
});

// ── classifyAbuse — chat_volume boundaries (soft1=10, soft2=20, hard=30) ──

describe("classifyAbuse — threshold boundaries via chat_volume dimension", () => {
  function metricsAt(state: string) {
    return { id: "m1", chat_volume_limit_state: state };
  }

  it("value = soft1 - 1 → stays ok, no write (below soft1)", async () => {
    h.metricsRow = metricsAt("ok");
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 9n });
    expect(h.safeAwaitLabels).toHaveLength(0);
  });

  it("value = soft1 exactly → classifies as soft1, transition written", async () => {
    h.metricsRow = metricsAt("ok");
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 10n });
    expect(h.safeAwaitLabels).toContain("usage_limit_events.insert");
    expect(h.safeAwaitLabels).toContain("tenant_usage_metrics.update");
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("soft1");
  });

  it("value = soft2 - 1 → soft1, not soft2", async () => {
    h.metricsRow = metricsAt("ok");
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 19n });
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("soft1");
  });

  it("value = soft2 exactly → classifies as soft2", async () => {
    h.metricsRow = metricsAt("ok");
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 20n });
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("soft2");
  });

  it("value = hard - 1 → soft2, not hard", async () => {
    h.metricsRow = metricsAt("ok");
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 29n });
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("soft2");
  });

  it("value = hard exactly → classifies as hard", async () => {
    h.metricsRow = metricsAt("ok");
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 30n });
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("hard");
  });

  it("value > hard → still hard (no state beyond hard)", async () => {
    h.metricsRow = metricsAt("ok");
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 9999n });
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("hard");
  });
});

// ── monotonic rank guard ───────────────────────────────────────────────────

describe("checkStateTransitionIfNeeded — monotonic guard (no downgrade)", () => {
  it("no write when new = current (RANK[soft1]=1 <= RANK[soft1]=1)", async () => {
    h.metricsRow = { id: "m1", chat_volume_limit_state: "soft1" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 10n }); // still soft1
    expect(h.safeAwaitLabels).toHaveLength(0);
    expect(h.inngestEvents).toHaveLength(0);
  });

  it("no write when new rank is lower (soft1 < soft2 — no downgrade)", async () => {
    h.metricsRow = { id: "m1", chat_volume_limit_state: "soft2" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 15n }); // soft1-level
    expect(h.safeAwaitLabels).toHaveLength(0);
    expect(h.inngestEvents).toHaveLength(0);
  });

  it("DOES write when new rank is higher (soft1 → soft2)", async () => {
    h.metricsRow = { id: "m1", chat_volume_limit_state: "soft1" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 20n }); // soft2
    expect(h.inngestEvents).toHaveLength(1);
    const ev = h.inngestEvents[0] as { data: { from_state: string; to_state: string } };
    expect(ev.data.from_state).toBe("soft1");
    expect(ev.data.to_state).toBe("soft2");
  });

  it("DOES write when jumping ok → hard (skips intermediate states)", async () => {
    h.metricsRow = { id: "m1", chat_volume_limit_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 30n }); // hard
    const ev = h.inngestEvents[0] as { data: { from_state: string; to_state: string } };
    expect(ev.data.from_state).toBe("ok");
    expect(ev.data.to_state).toBe("hard");
  });
});

// ── ai_cost — bigint boundaries (soft1=100n, soft2=200n, hard=300n) ────────

describe("classifyAbuse — ai_cost bigint boundaries", () => {
  it("99n → ok, no write", async () => {
    h.metricsRow = { id: "m1", ai_cost_limit_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "ai_cost", metric_value: 99n });
    expect(h.safeAwaitLabels).toHaveLength(0);
  });

  it("100n → soft1 (at soft1 boundary)", async () => {
    h.metricsRow = { id: "m1", ai_cost_limit_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "ai_cost", metric_value: 100n });
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("soft1");
  });

  it("300n → hard (at hard boundary)", async () => {
    h.metricsRow = { id: "m1", ai_cost_limit_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "ai_cost", metric_value: 300n });
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("hard");
  });
});

// ── classifyRag — RAG boundaries (effective=60, approaching=45) ────────────

describe("classifyRag — RAG state boundaries", () => {
  it("count < approaching → ok, no write (same state)", async () => {
    h.ragRow = { rag_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "rag_cap", metric_value: 44 });
    expect(h.safeAwaitLabels).toHaveLength(0);
  });

  it("count = approaching exactly → approaching (at boundary, transitions from ok)", async () => {
    h.ragRow = { rag_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "rag_cap", metric_value: 45 });
    expect(h.safeAwaitLabels).toContain("tenant_rag_quotas.update");
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("approaching");
  });

  it("count = approaching + 1 (still below effective) → approaching", async () => {
    h.ragRow = { rag_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "rag_cap", metric_value: 46 });
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("approaching");
  });

  it("count = effective - 1 → approaching (just below cap)", async () => {
    h.ragRow = { rag_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "rag_cap", metric_value: 59 });
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("approaching");
  });

  it("count = effective exactly → at_cap (NOT over_cap; count > effective is false)", async () => {
    h.ragRow = { rag_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "rag_cap", metric_value: 60 });
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("at_cap");
  });

  it("count = effective + 1 → over_cap (strictly greater)", async () => {
    h.ragRow = { rag_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "rag_cap", metric_value: 61 });
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("over_cap");
  });

  it("no write when current state equals computed state (non-monotonic noop)", async () => {
    h.ragRow = { rag_state: "approaching" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "rag_cap", metric_value: 45 }); // still approaching
    expect(h.safeAwaitLabels).toHaveLength(0);
    expect(h.inngestEvents).toHaveLength(0);
  });

  it("non-monotonic: at_cap → approaching is written (RAG allows downgrades)", async () => {
    h.ragRow = { rag_state: "at_cap" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "rag_cap", metric_value: 45 }); // approaching
    const ev = h.inngestEvents[0] as { data: { from_state: string; to_state: string } };
    expect(ev.data.from_state).toBe("at_cap");
    expect(ev.data.to_state).toBe("approaching");
  });

  it("non-monotonic: over_cap → ok is written when chunks drop back down", async () => {
    h.ragRow = { rag_state: "over_cap" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "rag_cap", metric_value: 10 }); // below approaching
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("ok");
  });

  it("no quota row → early return (caller will create the row on first chunk write)", async () => {
    h.ragRow = null;
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "rag_cap", metric_value: 60 });
    expect(h.safeAwaitLabels).toHaveLength(0);
    expect(h.inngestEvents).toHaveLength(0);
  });
});

// ── email_volume dimension — column dispatch ───────────────────────────────
// These tests verify the MONTHLY_DIM_META column strings for email_volume.
// Without them, Stryker survives by replacing "email_volume_limit_state" → "".

describe("checkStateTransitionIfNeeded — email_volume dimension", () => {
  it("reads email_volume_limit_state column (not soft2 → soft1 downgrade blocked)", async () => {
    // currentState read from row[meta.state_col] = row["email_volume_limit_state"]
    // newState = classifyAbuse(5n, thresholds.email_volume_daily) = soft1 (boundary)
    // rank(soft1)=1 <= rank(soft2)=2 → monotonic guard fires → no write
    h.metricsRow = { id: "m1", email_volume_limit_state: "soft2" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "email_volume", metric_value: 5n });
    expect(h.safeAwaitLabels).toHaveLength(0);
    expect(h.inngestEvents).toHaveLength(0);
  });

  it("writes email_volume upward transition (ok → soft1)", async () => {
    h.metricsRow = { id: "m1", email_volume_limit_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "email_volume", metric_value: 5n }); // soft1 boundary
    expect(h.inngestEvents).toHaveLength(1);
    const ev = h.inngestEvents[0] as { data: { dimension: string; to_state: string } };
    expect(ev.data.dimension).toBe("email_volume");
    expect(ev.data.to_state).toBe("soft1");
  });

  it("email_volume value = soft2 exactly → classifies as soft2", async () => {
    h.metricsRow = { id: "m1", email_volume_limit_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "email_volume", metric_value: 10n }); // soft2 boundary
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("soft2");
  });

  it("email_volume value = hard exactly → classifies as hard", async () => {
    h.metricsRow = { id: "m1", email_volume_limit_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "email_volume", metric_value: 15n }); // hard boundary
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("hard");
  });
});

// ── group_invite dimension — column dispatch ───────────────────────────────

describe("checkStateTransitionIfNeeded — group_invite dimension", () => {
  it("reads group_invite_limit_state column (soft2 → soft1 downgrade blocked)", async () => {
    // newState = classifyAbuse(50n, group_invite_monthly) = soft1 (MOCK soft1=50)
    // currentState = "soft2"; rank(soft1)=1 <= rank(soft2)=2 → no write
    h.metricsRow = { id: "m1", group_invite_limit_state: "soft2" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "group_invite", metric_value: 50n });
    expect(h.safeAwaitLabels).toHaveLength(0);
    expect(h.inngestEvents).toHaveLength(0);
  });

  it("writes group_invite upward transition (ok → soft2)", async () => {
    h.metricsRow = { id: "m1", group_invite_limit_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "group_invite", metric_value: 100n }); // soft2 boundary
    expect(h.inngestEvents).toHaveLength(1);
    const ev = h.inngestEvents[0] as { data: { dimension: string; to_state: string } };
    expect(ev.data.dimension).toBe("group_invite");
    expect(ev.data.to_state).toBe("soft2");
  });

  it("group_invite hard threshold is distinct from soft2 boundary", async () => {
    h.metricsRow = { id: "m1", group_invite_limit_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "group_invite", metric_value: 200n }); // hard boundary
    const ev = h.inngestEvents[0] as { data: { to_state: string } };
    expect(ev.data.to_state).toBe("hard");
  });
});

// ── threshold_crossed audit field ─────────────────────────────────────────

describe("checkStateTransitionIfNeeded — threshold_crossed in Inngest event", () => {
  it("threshold_crossed = soft1 threshold when entering soft1", async () => {
    h.metricsRow = { id: "m1", chat_volume_limit_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 10n });
    const ev = h.inngestEvents[0] as { data: { threshold_crossed: string } };
    expect(ev.data.threshold_crossed).toBe("10"); // MOCK soft1
  });

  it("threshold_crossed = soft2 threshold when entering soft2", async () => {
    h.metricsRow = { id: "m1", chat_volume_limit_state: "soft1" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 20n });
    const ev = h.inngestEvents[0] as { data: { threshold_crossed: string } };
    expect(ev.data.threshold_crossed).toBe("20"); // MOCK soft2
  });

  it("threshold_crossed = hard threshold when entering hard", async () => {
    h.metricsRow = { id: "m1", chat_volume_limit_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 30n });
    const ev = h.inngestEvents[0] as { data: { threshold_crossed: string } };
    expect(ev.data.threshold_crossed).toBe("30"); // MOCK hard
  });
});

// ── Inngest event payload ──────────────────────────────────────────────────

describe("checkStateTransitionIfNeeded — Inngest event payload", () => {
  it("event carries tenant_id, dimension, from/to state, and metric_value", async () => {
    h.metricsRow = { id: "m1", chat_volume_limit_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "chat_volume", metric_value: 10n });
    const ev = h.inngestEvents[0] as { name: string; data: Record<string, string> };
    expect(ev.name).toBe("abuse.state_transition");
    expect(ev.data.tenant_id).toBe("t-1");
    expect(ev.data.dimension).toBe("chat_volume");
    expect(ev.data.from_state).toBe("ok");
    expect(ev.data.to_state).toBe("soft1");
    expect(ev.data.metric_value).toBe("10");
    expect(ev.data.threshold_crossed).toBe("10"); // soft1 threshold
  });

  it("RAG event carries 'rag_cap' as dimension and effective as threshold_crossed", async () => {
    h.ragRow = { rag_state: "ok" };
    await checkStateTransitionIfNeeded({ db: makeDb(), tenant: TENANT, dimension: "rag_cap", metric_value: 45 });
    const ev = h.inngestEvents[0] as { data: { dimension: string; threshold_crossed: string } };
    expect(ev.data.dimension).toBe("rag_cap");
    // threshold_crossed for RAG = effective cap value
    expect(ev.data.threshold_crossed).toBe("60"); // MOCK effective
  });
});
