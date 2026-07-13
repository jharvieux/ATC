// #1815 — the two service-role `conversations.update` calls in
// deliverChatResponse (escalation status flip + last_message_at/count bump)
// used to filter by `.eq("id", conversationId)` only — single-layer tenant
// isolation (D-091 #4), carried behind now-removed `d091-allow:service-role-tenant`
// suppressions. Both now chain `.eq("tenant_id", tenantId)` too; this pins
// that a future edit can't silently drop the second filter.

import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { deliverChatResponse } from "@/lib/chat/deliver-chat-response";

type EqCall = [string, unknown];

// A chainable builder that records every `.eq()` call and resolves like a
// Supabase query once awaited (safeAwait does `await query`).
function chainableBuilder(eqCalls: EqCall[]) {
  const builder = {
    update: () => builder,
    insert: () => Promise.resolve({ data: null, error: null }),
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return builder;
    },
    then: (resolve: (v: { data: null; error: null }) => void) => resolve({ data: null, error: null }),
  };
  return builder;
}

function makeSvc(conversationsEqCalls: EqCall[]) {
  return {
    from: (table: string) => {
      if (table === "conversations") return chainableBuilder(conversationsEqCalls);
      if (table === "messages") return chainableBuilder([]);
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;
}

const TENANT_ID = "11111111-2222-3333-4444-555555555555";
const CONVERSATION_ID = "99999999-8888-7777-6666-555555555555";
const ASSISTANT_MESSAGE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

type DeliverChatResponseArgs = Parameters<typeof deliverChatResponse>[0];

function baseArgs(
  svc: SupabaseClient,
  overrides: Partial<DeliverChatResponseArgs>,
): DeliverChatResponseArgs {
  return {
    svc,
    tenantId: TENANT_ID,
    conversationId: CONVERSATION_ID,
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    candidate: "Thanks for chatting!",
    supervisorOutcome: null,
    availableAssetIds: [],
    retrievedAssets: [],
    streamingEnabled: false,
    streamedAttempts: 1,
    perSentenceFires: 0,
    postStreamSupervisorFires: 0,
    customerCurrentCount: 0,
    send: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("deliverChatResponse — tenant-scoped conversations.update (#1815)", () => {
  it("scopes the escalation status-flip update to id AND tenant_id", async () => {
    const eqCalls: EqCall[] = [];
    const svc = makeSvc(eqCalls);
    await deliverChatResponse(
      baseArgs(svc, {
        supervisorOutcome: { action: "escalate" } as DeliverChatResponseArgs["supervisorOutcome"],
      }),
    );
    expect(eqCalls).toContainEqual(["id", CONVERSATION_ID]);
    expect(eqCalls).toContainEqual(["tenant_id", TENANT_ID]);
  });

  it("scopes the last_message_at/count bump update to id AND tenant_id", async () => {
    const eqCalls: EqCall[] = [];
    const svc = makeSvc(eqCalls);
    await deliverChatResponse(baseArgs(svc, {}));
    expect(eqCalls).toContainEqual(["id", CONVERSATION_ID]);
    expect(eqCalls).toContainEqual(["tenant_id", TENANT_ID]);
  });
});
