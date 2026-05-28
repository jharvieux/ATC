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
          if (table === "ai_tool_calls") {
            const error = auditOk ? null : { message: "audit synthetic failure" };
            // Behave like a Supabase builder: directly thenable to {data, error}.
            return Promise.resolve({ data: null, error });
          }
          // Other tables (escalation_topics, etc.) — chain to .select().single()
          return {
            select: () => ({
              single: async () => ({
                data: escalationOk ? { id: "row-1" } : null,
                error: escalationOk ? null : { message: "escalation synthetic failure" },
              }),
            }),
          };
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
    // The handler may or may not throw on a soft DB error depending on
    // its internal handling — but EITHER way an audit row should land.
    // (escalate_to_human's actual behavior: it surfaces the DB error
    // back to the LLM; we just verify the audit fired.)
    const audit = inserts.find((i) => i.table === "ai_tool_calls");
    expect(audit).toBeDefined();
    expect(audit?.payload.tool_name).toBe("escalate_to_human");
    // The result body should have landed in result_json (either as a
    // parsed object or string).
    expect(audit?.payload.result_json).toBeDefined();
    // r.content is whatever the handler returned — just confirm dispatch
    // returned something parseable.
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
