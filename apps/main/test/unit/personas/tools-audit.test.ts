// §9.6 — audit write coverage for the tool dispatcher.
//
// Every dispatch path (success / unknown_tool / handler error) writes
// one row to ai_tool_calls. Failures of the audit insert itself MUST
// NOT abort the dispatch — the LLM is mid-turn.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchTool } from "@/lib/personas/tools/dispatch";
import type { TenantContext } from "@/lib/db/tenant-context";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CONVERSATION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const ctx: TenantContext = {
  tenant_id: TENANT,
  source: { kind: "http_request", user_id: "00000000-0000-0000-0000-000000000001" },
};

interface RecordedInsert {
  table: string;
  payload: Record<string, unknown>;
}

function makeDb(opts: {
  inserts: RecordedInsert[];
  escalationInsertOk?: boolean;
  auditInsertOk?: boolean;
}) {
  const escalationOk = opts.escalationInsertOk ?? true;
  const auditOk = opts.auditInsertOk ?? true;
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        insert: (payload: Record<string, unknown>) => {
          opts.inserts.push({ table, payload });
          const result =
            table === "ai_tool_calls"
              ? { data: null, error: auditOk ? null : { message: "audit synthetic failure" } }
              : {
                  data: escalationOk ? { id: "row-1" } : null,
                  error: escalationOk ? null : { message: "escalation synthetic failure" },
                };
          // Support BOTH call shapes Supabase builders allow: a direct
          // `await db...insert(...)` (what escalate_to_human does via
          // safeAwait) AND `db...insert(...).select().single()`. The mock
          // previously only chained .select().single(), so safeAwait
          // awaited a non-thenable and never saw the error → the handler
          // never threw and error_text was never exercised.
          return Object.assign(Promise.resolve(result), {
            select: () => ({ single: async () => result }),
          });
        },
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
      });
      return chain;
    },
  } as unknown as Parameters<typeof dispatchTool>[2]["db"];
}

const errorLogSpy = vi.spyOn(console, "error").mockImplementation(() => {});
beforeEach(() => {
  errorLogSpy.mockClear();
});

describe("ai_tool_calls audit write", () => {
  it("records a success dispatch with input + result + was_mutating", async () => {
    const inserts: RecordedInsert[] = [];
    const db = makeDb({ inserts });
    const r = await dispatchTool(
      "escalate_to_human",
      { reason: "complex_booking", summary: "test", urgency: "high" },
      { ctx, db, conversation_id: CONVERSATION, tool_use_id: "tu_123" },
    );
    expect(r.was_mutating).toBe(true);

    const audit = inserts.find((i) => i.table === "ai_tool_calls");
    expect(audit).toBeDefined();
    expect(audit?.payload).toMatchObject({
      tenant_id: TENANT,
      conversation_id: CONVERSATION,
      tool_name: "escalate_to_human",
      tool_use_id: "tu_123",
      was_mutating: true,
      error_text: null,
    });
    expect(audit?.payload.input_json).toMatchObject({ reason: "complex_booking" });
    expect(typeof audit?.payload.duration_ms).toBe("number");
  });

  it("records unknown_tool dispatches with error_text=unknown_tool", async () => {
    const inserts: RecordedInsert[] = [];
    const db = makeDb({ inserts });
    await dispatchTool(
      "delete_database",
      {},
      { ctx, db, conversation_id: CONVERSATION },
    );
    const audit = inserts.find((i) => i.table === "ai_tool_calls");
    expect(audit?.payload).toMatchObject({
      tool_name: "delete_database",
      was_mutating: false,
      error_text: "unknown_tool",
    });
  });

  it("records handler-error dispatches with error_text set", async () => {
    const inserts: RecordedInsert[] = [];
    // Build a db whose escalation_topics insert errors but ai_tool_calls
    // works normally — the dispatcher catches handler errors and still
    // writes the audit row.
    const db = makeDb({ inserts, escalationInsertOk: false });
    const r = await dispatchTool(
      "escalate_to_human",
      { reason: "complex_booking", summary: "x" },
      { ctx, db, conversation_id: CONVERSATION },
    );
    // escalate_to_human wraps its escalation_topics insert in safeAwait,
    // which THROWS on a DB error (D-094). dispatchTool catches that and
    // records the audit row with error_text set to the failure detail.
    // (Not "may or may not throw" — safeAwait always throws on error.)
    const audit = inserts.find((i) => i.table === "ai_tool_calls");
    expect(audit).toBeDefined();
    expect(audit?.payload.tool_name).toBe("escalate_to_human");
    // The point of THIS test (vs. the unknown-tool case above): the
    // handler-threw path populates error_text with the failure detail.
    expect(audit?.payload.error_text).toBeTruthy();
    expect(String(audit?.payload.error_text)).toContain("escalation_topics.insert");
    // Dispatch still returns a tool_result the LLM can reason about.
    expect(typeof r.content).toBe("string");
  });

  it("does not abort dispatch when audit insert fails", async () => {
    const inserts: RecordedInsert[] = [];
    const db = makeDb({ inserts, auditInsertOk: false });
    const r = await dispatchTool(
      "escalate_to_human",
      { reason: "complex_booking", summary: "x" },
      { ctx, db, conversation_id: CONVERSATION },
    );
    // Dispatch still returns the normal result.
    expect(r.content).toBeDefined();
    // And we logged the audit failure loud.
    expect(errorLogSpy).toHaveBeenCalled();
    const firstCall = errorLogSpy.mock.calls[0];
    expect(firstCall?.join(" ")).toContain("ai_tool_calls");
  });
});
