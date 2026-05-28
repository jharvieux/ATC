// §9.6 — Tool dispatcher + per-handler unit tests.

import { describe, it, expect } from "vitest";
import { dispatchTool, listKnownTools } from "@/lib/personas/tools/dispatch";
import type { TenantContext } from "@/lib/db/tenant-context";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CONVERSATION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CONTACT = "99999999-8888-7777-6666-555555555555";

const ctx: TenantContext = {
  tenant_id: TENANT,
  // Any valid TenantContext kind works for these tests — handlers only
  // read ctx.tenant_id. http_request is the most common path; once F1
  // merges, public_token_chat will be the actual path on token surfaces.
  source: { kind: "http_request", user_id: "00000000-0000-0000-0000-000000000001" },
};

function makeDb(routes: Record<string, { rows?: unknown[]; row?: unknown | null; error?: { message: string } | null }>) {
  return {
    from(table: string) {
      const lookup: Record<string, string> = {};
      const limitVal = { value: 0 };
      const order = { col: "", asc: true };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        insert: (_payload: unknown) => ({
          select: () => ({
            single: async () => {
              const key = `${table}:insert`;
              const hit = routes[key];
              return { data: hit?.row ?? null, error: hit?.error ?? null };
            },
          }),
        }),
        eq: (col: string, val: string) => {
          lookup[col] = val;
          return chain;
        },
        order: (col: string, opts: { ascending: boolean }) => {
          order.col = col;
          order.asc = opts.ascending;
          return chain;
        },
        limit: (n: number) => {
          limitVal.value = n;
          return chain;
        },
        maybeSingle: async () => {
          const key = `${table}:get`;
          const hit = routes[key];
          return { data: hit?.row ?? null, error: hit?.error ?? null };
        },
      });
      // For list queries returning rows + count
      Object.defineProperty(chain, "then", {
        value: (resolve: (v: unknown) => void) => {
          const key = `${table}:list`;
          const hit = routes[key];
          resolve({ data: hit?.rows ?? null, error: hit?.error ?? null });
        },
      });
      return chain;
    },
  } as unknown as Parameters<typeof dispatchTool>[2]["db"];
}

describe("tool dispatcher", () => {
  it("listKnownTools returns the 6 spec tools", () => {
    const tools = listKnownTools();
    expect(tools).toEqual(
      expect.arrayContaining([
        "escalate_to_human",
        "get_customer_context",
        "update_memory",
        "search_host_inventory",
        "generate_quote",
        "collect_booking_details",
      ]),
    );
    expect(tools).toHaveLength(6);
  });

  it("returns unknown_tool error for unregistered name", async () => {
    const r = await dispatchTool(
      "delete_database",
      {},
      { ctx, db: makeDb({}), conversation_id: CONVERSATION },
    );
    const parsed = JSON.parse(r.content) as { error?: string };
    expect(parsed.error).toBe("unknown_tool");
    expect(r.was_mutating).toBe(false);
  });

  it("wraps handler exceptions into tool_handler_failed", async () => {
    // Force a thrown error inside the dispatcher's try/catch by passing
    // a db whose `from()` throws synchronously. (More direct than going
    // through a real handler — the catch path is what we're testing.)
    const throwingDb = {
      from: () => {
        throw new Error("synthetic db failure");
      },
    } as unknown as Parameters<typeof dispatchTool>[2]["db"];
    const r = await dispatchTool(
      "escalate_to_human",
      { reason: "customer_requested", summary: "x" },
      { ctx, db: throwingDb, conversation_id: CONVERSATION },
    );
    const parsed = JSON.parse(r.content) as { error?: string; detail?: string };
    expect(parsed.error).toBe("tool_handler_failed");
    expect(parsed.detail).toContain("synthetic");
  });
});

describe("escalate_to_human", () => {
  it("rejects invalid reason enum", async () => {
    const r = await dispatchTool(
      "escalate_to_human",
      { reason: "made_up_reason", summary: "x" },
      { ctx, db: makeDb({}), conversation_id: CONVERSATION },
    );
    expect(JSON.parse(r.content).error).toBe("invalid_input");
  });

  it("opens an escalation_topics row on valid input", async () => {
    const db = makeDb({ "escalation_topics:insert": { row: { id: "e1" } } });
    const r = await dispatchTool(
      "escalate_to_human",
      {
        reason: "complex_booking",
        summary: "Customer needs help with multi-cabin family group",
        urgency: "high",
      },
      { ctx, db, conversation_id: CONVERSATION },
    );
    const parsed = JSON.parse(r.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.reason).toBe("complex_booking");
    expect(parsed.urgency).toBe("high");
    expect(r.was_mutating).toBe(true);
  });
});

describe("get_customer_context", () => {
  it("returns no_customer_in_session when contact_id is missing", async () => {
    const r = await dispatchTool(
      "get_customer_context",
      {},
      { ctx, db: makeDb({}), conversation_id: CONVERSATION },
    );
    expect(JSON.parse(r.content).error).toBe("no_customer_in_session");
  });

  it("returns contact_not_found when DB has no contact row", async () => {
    const db = makeDb({ "contacts:get": { row: null } });
    const r = await dispatchTool(
      "get_customer_context",
      {},
      { ctx, db, conversation_id: CONVERSATION, contact_id: CONTACT },
    );
    expect(JSON.parse(r.content).error).toBe("contact_not_found");
  });
});

describe("update_memory", () => {
  it("rejects unknown memory_type", async () => {
    const r = await dispatchTool(
      "update_memory",
      { memory_type: "bogus", content: "x" },
      { ctx, db: makeDb({}), conversation_id: CONVERSATION, contact_id: CONTACT },
    );
    expect(JSON.parse(r.content).error).toBe("invalid_input");
  });

  it("requires a contact_id", async () => {
    const r = await dispatchTool(
      "update_memory",
      { memory_type: "preference", content: "Loves balcony cabins" },
      { ctx, db: makeDb({}), conversation_id: CONVERSATION },
    );
    expect(JSON.parse(r.content).error).toBe("no_customer_in_session");
  });

  it("writes to memory_extractions with pending_customer_review status", async () => {
    const db = makeDb({ "memory_extractions:insert": { row: { id: "m1" } } });
    const r = await dispatchTool(
      "update_memory",
      { memory_type: "preference", content: "Loves balcony cabins" },
      { ctx, db, conversation_id: CONVERSATION, contact_id: CONTACT },
    );
    const parsed = JSON.parse(r.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.memory_extraction_id).toBe("m1");
    expect(parsed.memory_type).toBe("preference");
    expect(r.was_mutating).toBe(true);
  });
});

describe("placeholder handlers return not_implemented", () => {
  for (const tool of ["search_host_inventory", "generate_quote", "collect_booking_details"]) {
    it(`${tool} returns not_implemented + escalate fallback`, async () => {
      const r = await dispatchTool(
        tool,
        {},
        { ctx, db: makeDb({}), conversation_id: CONVERSATION, contact_id: CONTACT },
      );
      const parsed = JSON.parse(r.content);
      expect(parsed.error).toBe("not_implemented");
      expect(parsed.can_fall_back_to).toBe("escalate_to_human");
      expect(r.was_mutating).toBe(false);
    });
  }
});
