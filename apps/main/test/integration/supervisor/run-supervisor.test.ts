// Integration tests for runSupervisor — §10.1 / §10.1a
//
// Tests the full supervisor flow against mock DB clients. Each mock is
// purpose-built for its test scenario — we're testing the harness logic
// (budget enforcement, kill switch, slur escalation), not the DB itself.
//
// WHY integration (not unit):
// runSupervisor composes multiple DB reads and writes in a specific order.
// Unit tests on the pure checks live in test/unit/supervisor/. These tests
// verify the composed flow, including the budget state machine.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSupervisor } from "@/lib/supervisor/run-supervisor";
import type { TenantContext } from "@/lib/db/tenant-context";
import { _resetPlatformSettingCacheForTests } from "@/lib/platform/platform-setting-cache";

// #1586 — the supervisor's slur deny list is now served from a shared 60s
// platform_settings cache. Reset it between specs so each test's mocked
// slurDenyList (not a prior test's cached list) drives the escalation logic.
beforeEach(() => {
  _resetPlatformSettingCacheForTests();
});

const TENANT_ID = "tenant-test-uuid";
const CONVERSATION_ID = "conv-test-uuid";
const MESSAGE_ID = "msg-test-uuid";

const ctx: TenantContext = {
  tenant_id: TENANT_ID,
  source: { kind: "http_request", user_id: "user-test-uuid" },
};

// A response with a warning phrase to trigger regen logic
const WARNING_RESPONSE = "I guarantee this cabin is ocean-view.";
// A clean response that passes all checks
const CLEAN_RESPONSE = "Ocean-view cabins are typically available.";
// A response containing a fixture slur word
const SLUR_RESPONSE = "BANNED_WORD_FIXTURE is in this response.";

// ── Mock DB factory helpers ──────────────────────────────────────────────────

function makeConversation(overrides: Partial<{
  regen_tokens_consumed: number;
  regen_count_total: number;
  regen_budget_exhausted_at: string | null;
  supervisor_slur_consecutive_count: number;
}> = {}) {
  return {
    regen_tokens_consumed: 0,
    regen_count_total: 0,
    regen_budget_exhausted_at: null,
    supervisor_slur_consecutive_count: 0,
    ...overrides,
  };
}

type MockConversationRow = ReturnType<typeof makeConversation>;

function buildMockDb(opts: {
  conversation: MockConversationRow;
  killSwitchPaused?: boolean;
  killSwitchError?: boolean;
  slurDenyList?: string[];
  conversationUpdates?: (patch: Record<string, unknown>) => void;
  escalationInserts?: (row: Record<string, unknown>) => void;
}): SupabaseClient {
  const {
    conversation,
    killSwitchPaused = false,
    killSwitchError = false,
    slurDenyList = [],
    conversationUpdates,
    escalationInserts,
  } = opts;

  const updatedConversation = { ...conversation };

  // Helper: returns a thenable object that also supports chained .eq() calls.
  // Necessary because queries now chain two .eq() filters (id + tenant_id).
  function makeUpdateChain(
    patch: Record<string, unknown>,
    onFirstEq: () => void,
  ) {
    const result = { data: null, error: null };
    const p = Promise.resolve(result);
    const chain: Record<string, unknown> = {
      eq: () => chain,
      then: p.then.bind(p),
      catch: p.catch.bind(p),
    };
    return {
      eq: (_col: string, _val: unknown) => {
        onFirstEq();
        return chain;
      },
    };
  }

  // Helper: returns a select chain that supports multiple .eq() calls before terminal.
  function makeSelectChain(terminal: Record<string, unknown>) {
    const chain: Record<string, unknown> = { eq: () => chain, ...terminal };
    return chain;
  }

  const db = {
    from: (table: string) => {
      if (table === "conversations") {
        return {
          select: () => makeSelectChain({
            single: async () => ({ data: { ...updatedConversation }, error: null }),
          }),
          update: (patch: Record<string, unknown>) => makeUpdateChain(patch, () => {
            Object.assign(updatedConversation, patch);
            conversationUpdates?.(patch);
          }),
        };
      }
      if (table === "ai_kill_switch_state") {
        return {
          select: () => ({
            eq: () => ({
              single: async () =>
                killSwitchError
                  ? { data: null, error: { message: "kill-switch read failed" } }
                  : { data: { global_paused: killSwitchPaused }, error: null },
            }),
          }),
        };
      }
      if (table === "platform_settings") {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              // Support both .single() (old callers) and .maybeSingle() (load-deny-list post-fix)
              single: async () => {
                if (key === "supervisor_slur_deny_list") {
                  return { data: { value: slurDenyList }, error: null };
                }
                return { data: null, error: null };
              },
              maybeSingle: async () => {
                if (key === "supervisor_slur_deny_list") {
                  return { data: { value: slurDenyList }, error: null };
                }
                return { data: null, error: null };
              },
            }),
          }),
        };
      }
      if (table === "tenant_settings") {
        // §24.5 BP24 added a supplemental deny-list lookup here.
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                ({ data: { supplemental_hate_speech_denylist: [] }, error: null }),
            }),
          }),
        };
      }
      if (table === "messages") {
        return {
          update: (patch: Record<string, unknown>) => makeUpdateChain(patch, () => {}),
        };
      }
      if (table === "escalation_topics") {
        return {
          insert: (row: Record<string, unknown>) => {
            escalationInserts?.(row);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
        update: (patch: Record<string, unknown>) => makeUpdateChain(patch, () => {}),
        insert: () => Promise.resolve({ data: null, error: null }),
      };
    },
  } as unknown as SupabaseClient;

  return db;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("runSupervisor — regen count budget (§10.1a)", () => {
  it("allows regen when count is below MAX_PER_CONVERSATION", async () => {
    const updatedPatches: Record<string, unknown>[] = [];
    const db = buildMockDb({
      conversation: makeConversation({ regen_count_total: 5 }),
      conversationUpdates: (patch) => updatedPatches.push(patch),
    });

    // Set limit to 6 so one more regen is allowed
    process.env.SUPERVISOR_REGEN_MAX_PER_CONVERSATION = "6";
    process.env.SUPERVISOR_REGEN_MAX_TOKENS_PER_CONVERSATION = "25000";

    const result = await runSupervisor({
      ctx,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      candidate_response: WARNING_RESPONSE,
      db,
    });

    expect(result.action).toBe("regenerate");
    // The regen count should have been incremented
    const countUpdate = updatedPatches.find(
      (p) => "regen_count_total" in p,
    );
    expect(countUpdate?.regen_count_total).toBe(6);
  });

  it("escalates when count would exceed MAX_PER_CONVERSATION", async () => {
    const updatedPatches: Record<string, unknown>[] = [];
    const db = buildMockDb({
      conversation: makeConversation({ regen_count_total: 6 }),
      conversationUpdates: (patch) => updatedPatches.push(patch),
    });

    process.env.SUPERVISOR_REGEN_MAX_PER_CONVERSATION = "6";

    const result = await runSupervisor({
      ctx,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      candidate_response: WARNING_RESPONSE,
      db,
    });

    expect(result.action).toBe("escalate");
    expect(
      result.findings.some((f) => f.check === "regen_budget_exhausted"),
    ).toBe(true);
    // regen_budget_exhausted_at should have been set
    const exhaustionUpdate = updatedPatches.find(
      (p) => "regen_budget_exhausted_at" in p,
    );
    expect(exhaustionUpdate?.regen_budget_exhausted_at).toBeTruthy();
  });
});

describe("runSupervisor — regen token budget (§10.1a)", () => {
  it("escalates when token count would exceed MAX_TOKENS_PER_CONVERSATION", async () => {
    const updatedPatches: Record<string, unknown>[] = [];
    const db = buildMockDb({
      // Token budget nearly exhausted (24990 of 25000)
      conversation: makeConversation({ regen_tokens_consumed: 24990 }),
      conversationUpdates: (patch) => updatedPatches.push(patch),
    });

    process.env.SUPERVISOR_REGEN_MAX_PER_CONVERSATION = "6";
    process.env.SUPERVISOR_REGEN_MAX_TOKENS_PER_CONVERSATION = "25000";

    const result = await runSupervisor({
      ctx,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      // This response is long enough to push estimated tokens over the limit
      candidate_response: WARNING_RESPONSE + " ".repeat(100),
      db,
    });

    expect(result.action).toBe("escalate");
    const hasTokenExhaustion = result.findings.some(
      (f) => f.check === "regen_budget_exhausted",
    );
    expect(hasTokenExhaustion).toBe(true);
    const exhaustionUpdate = updatedPatches.find(
      (p) => "regen_budget_exhausted_at" in p,
    );
    expect(exhaustionUpdate?.regen_budget_exhausted_at).toBeTruthy();
  });
});

describe("runSupervisor — already-exhausted conversation (§10.1a)", () => {
  it("escalates without regen attempt when budget_exhausted_at is already set", async () => {
    const updatedPatches: Record<string, unknown>[] = [];
    const db = buildMockDb({
      conversation: makeConversation({
        regen_budget_exhausted_at: new Date().toISOString(),
        regen_count_total: 6,
      }),
      conversationUpdates: (patch) => updatedPatches.push(patch),
    });

    const result = await runSupervisor({
      ctx,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      candidate_response: WARNING_RESPONSE,
      db,
    });

    expect(result.action).toBe("escalate");
    // No regen_count_total increment — exhausted means no regen loop
    const countUpdate = updatedPatches.find((p) => "regen_count_total" in p);
    expect(countUpdate).toBeUndefined();
  });
});

describe("runSupervisor — kill switch (§10.6)", () => {
  it("returns escalate immediately when global_paused = true", async () => {
    const db = buildMockDb({
      conversation: makeConversation(),
      killSwitchPaused: true,
    });

    const result = await runSupervisor({
      ctx,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      candidate_response: CLEAN_RESPONSE,
      db,
    });

    expect(result.action).toBe("escalate");
    expect(result.findings[0]?.check).toBe("kill_switch");
    // regen_count should be 0 — no regen attempted before kill switch check
    expect(result.regen_count).toBe(0);
  });

  it("allows a clean response when kill switch is OFF", async () => {
    const db = buildMockDb({
      conversation: makeConversation(),
      killSwitchPaused: false,
    });

    const result = await runSupervisor({
      ctx,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      candidate_response: CLEAN_RESPONSE,
      db,
    });

    expect(result.action).toBe("allow");
  });

  it("fails closed (escalate) when the kill-switch read errors (#399)", async () => {
    // A DB read failure on the global safety switch must NOT fall through to
    // "not paused" and let generation proceed. An unreadable kill switch is an
    // unknown pause state, so the supervisor escalates to a human. If anyone
    // reverts to discarding the read error, this flips from escalate to allow.
    const db = buildMockDb({
      conversation: makeConversation(),
      killSwitchError: true,
    });

    const result = await runSupervisor({
      ctx,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      candidate_response: CLEAN_RESPONSE,
      db,
    });

    expect(result.action).toBe("escalate");
    expect(result.findings[0]?.check).toBe("kill_switch_read_error");
    expect(result.regen_count).toBe(0);
  });
});

describe("runSupervisor — slur consecutive-hit escalation (§10.2 tone_drift)", () => {
  it("opens escalation_topics on the 3rd consecutive critical tone_drift hit", async () => {
    const escalationRows: Record<string, unknown>[] = [];

    const db = buildMockDb({
      // 2 prior consecutive hits — this call is the 3rd
      conversation: makeConversation({ supervisor_slur_consecutive_count: 2 }),
      slurDenyList: ["BANNED_WORD_FIXTURE"],
      escalationInserts: (row) => escalationRows.push(row),
    });

    process.env.SUPERVISOR_REGEN_MAX_PER_CONVERSATION = "6";

    const result = await runSupervisor({
      ctx,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      candidate_response: SLUR_RESPONSE,
      db,
    });

    // tone_drift critical → action escalate
    expect(result.action).toBe("escalate");
    // escalation_topics row should have been inserted
    expect(escalationRows.length).toBe(1);
    expect(escalationRows[0]?.initiated_by).toBe("supervisor");
    expect(escalationRows[0]?.status).toBe("open");
  });

  it("does NOT open escalation on the 2nd consecutive hit (threshold is 3)", async () => {
    const escalationRows: Record<string, unknown>[] = [];

    const db = buildMockDb({
      conversation: makeConversation({ supervisor_slur_consecutive_count: 1 }),
      slurDenyList: ["BANNED_WORD_FIXTURE"],
      escalationInserts: (row) => escalationRows.push(row),
    });

    process.env.SUPERVISOR_REGEN_MAX_PER_CONVERSATION = "6";

    await runSupervisor({
      ctx,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      candidate_response: SLUR_RESPONSE,
      db,
    });

    expect(escalationRows.length).toBe(0);
  });

  it("resets consecutive count on a clean message", async () => {
    const conversationUpdates: Record<string, unknown>[] = [];

    const db = buildMockDb({
      conversation: makeConversation({ supervisor_slur_consecutive_count: 2 }),
      slurDenyList: ["BANNED_WORD_FIXTURE"],
      conversationUpdates: (patch) => conversationUpdates.push(patch),
    });

    await runSupervisor({
      ctx,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      candidate_response: CLEAN_RESPONSE,
      db,
    });

    const countUpdate = conversationUpdates.find(
      (p) => "supervisor_slur_consecutive_count" in p,
    );
    expect(countUpdate?.supervisor_slur_consecutive_count).toBe(0);
  });
});

describe("runSupervisor — tenant_id filter on DB mutations (§D-091)", () => {
  it("conversations UPDATE and messages UPDATE both carry tenant_id eq filter", async () => {
    const conversationsEqArgs: Array<[string, unknown]> = [];
    const messagesEqArgs: Array<[string, unknown]> = [];

    function makeMutationChain(eqArgs: Array<[string, unknown]>) {
      const result = { data: null, error: null };
      const p = Promise.resolve(result);
      const chain: Record<string, unknown> = {
        eq: (col: string, val: unknown) => { eqArgs.push([col, val]); return chain; },
        then: p.then.bind(p),
        catch: p.catch.bind(p),
      };
      return { eq: (col: string, val: unknown) => { eqArgs.push([col, val]); return chain; } };
    }

    const db = {
      from: (table: string) => {
        if (table === "conversations") {
          const convData = makeConversation({ regen_count_total: 0 });
          const selChain: Record<string, unknown> = {};
          selChain.eq = () => selChain;
          selChain.single = async () => ({ data: convData, error: null });
          return {
            select: () => selChain,
            update: (_patch: Record<string, unknown>) => makeMutationChain(conversationsEqArgs),
          };
        }
        if (table === "ai_kill_switch_state") {
          return {
            select: () => ({
              eq: () => ({ single: async () => ({ data: { global_paused: false }, error: null }) }),
            }),
          };
        }
        if (table === "platform_settings") {
          return {
            select: () => ({
              eq: (_col: string, _key: string) => ({
                single: async () => ({ data: { value: [] }, error: null }),
                maybeSingle: async () => ({ data: { value: [] }, error: null }),
              }),
            }),
          };
        }
        if (table === "tenant_settings") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { supplemental_hate_speech_denylist: [] }, error: null }),
              }),
            }),
          };
        }
        if (table === "messages") {
          return {
            update: (_patch: Record<string, unknown>) => makeMutationChain(messagesEqArgs),
          };
        }
        if (table === "escalation_topics") {
          return { insert: () => Promise.resolve({ data: null, error: null }) };
        }
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
          update: (_patch: Record<string, unknown>) => makeMutationChain([]),
          insert: () => Promise.resolve({ data: null, error: null }),
        };
      },
    } as unknown as SupabaseClient;

    process.env.SUPERVISOR_REGEN_MAX_PER_CONVERSATION = "6";

    await runSupervisor({
      ctx,
      conversation_id: CONVERSATION_ID,
      message_id: MESSAGE_ID,
      candidate_response: WARNING_RESPONSE,
      db,
    });

    const convCols = conversationsEqArgs.map(([col]) => col);
    const msgCols = messagesEqArgs.map(([col]) => col);
    expect(convCols).toContain("id");
    expect(convCols).toContain("tenant_id");
    expect(msgCols).toContain("id");
    expect(msgCols).toContain("tenant_id");
    const convTenant = conversationsEqArgs.find(([col]) => col === "tenant_id");
    const msgTenant = messagesEqArgs.find(([col]) => col === "tenant_id");
    expect(convTenant?.[1]).toBe(TENANT_ID);
    expect(msgTenant?.[1]).toBe(TENANT_ID);
  });
});

describe("runSupervisor — sampling integration (§10.5a)", () => {
  // Per-test timeout bumped to 90s — the 30s default has flaked twice in
  // the merge cascade (jobs 77660638249, 77660757380). Each runSupervisor
  // call exercises the lexical screen + the mock DB; 20 iterations can
  // sit just under 30s on a noisy CI runner.
  it("simulates ~1% sampling rate for clean passes over 1000 runs", async () => {
    // We can't call maybeSampleForReview here (it needs its own DB mock),
    // but we can verify the supervisor returns 'allow' for clean responses,
    // which is the prerequisite for the 'clean_pass' sample category.
    let allowCount = 0;
    const iterations = 20;

    for (let i = 0; i < iterations; i++) {
      const db = buildMockDb({ conversation: makeConversation() });
      const result = await runSupervisor({
        ctx,
        conversation_id: CONVERSATION_ID,
        message_id: MESSAGE_ID,
        candidate_response: CLEAN_RESPONSE,
        db,
      });
      if (result.action === "allow") allowCount++;
    }

    // All clean responses should be allowed (the check is deterministic)
    expect(allowCount).toBe(iterations);
  }, 90_000);
});
