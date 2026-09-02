// #2112 — Counter helpers delegate delta consumption to atomic DB RPCs and
// pass the authoritative returned value into the retriable state check.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkState: vi.fn(),
  safeAwait: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/abuse/state-machine", () => ({
  checkStateTransitionIfNeeded: mocks.checkState,
}));

vi.mock("@/lib/db/safe-mutation", () => ({
  safeAwait: mocks.safeAwait,
}));

import {
  adjustRagChunkCount,
  incrementChatMessages,
  incrementEmailSent,
  incrementGroupInvitees,
} from "@/lib/abuse/counters";

const TENANT = {
  tenant_id: "t-1",
  tier_code: "sub_pro" as const,
  seat_count: 1,
  billing_period: "monthly" as const,
};

const db = { rpc: mocks.rpc } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockReturnValue(Promise.resolve({ data: null, error: null }));
  mocks.safeAwait.mockImplementation(async (_query: unknown, label: string) =>
    label.includes("tenant_rag_quotas") ? 7 : 11,
  );
  mocks.checkState.mockResolvedValue(false);
});

describe("monthly counters", () => {
  it("increments chat atomically and evaluates the returned total", async () => {
    await incrementChatMessages({ db, tenant: TENANT });

    expect(mocks.rpc).toHaveBeenCalledWith("increment_tenant_usage_counter", expect.objectContaining({
      p_tenant_id: "t-1",
      p_dimension: "chat_volume",
      p_amount: 1,
    }));
    expect(mocks.checkState).toHaveBeenCalledWith(expect.objectContaining({
      dimension: "chat_volume",
      metric_value: 11n,
    }));
  });

  it("uses the database's day-anchored email total", async () => {
    await incrementEmailSent({ db, tenant: TENANT });

    expect(mocks.rpc).toHaveBeenCalledWith("increment_tenant_usage_counter", expect.objectContaining({
      p_dimension: "email_volume",
      p_amount: 1,
    }));
    expect(mocks.checkState).toHaveBeenCalledWith(expect.objectContaining({
      dimension: "email_volume",
      metric_value: 11n,
    }));
  });

  it("applies the entire group-invite delta in one RPC", async () => {
    await incrementGroupInvitees({ db, tenant: TENANT }, 4);

    expect(mocks.rpc).toHaveBeenCalledWith("increment_tenant_usage_counter", expect.objectContaining({
      p_dimension: "group_invite",
      p_amount: 4,
    }));
  });

  it("rejects non-positive group deltas before touching the database", async () => {
    await incrementGroupInvitees({ db, tenant: TENANT }, 0);
    await incrementGroupInvitees({ db, tenant: TENANT }, -2);

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.checkState).not.toHaveBeenCalled();
  });
});

describe("RAG counter", () => {
  it("passes the signed delta and promoted count to the atomic floor RPC", async () => {
    await adjustRagChunkCount({ db, tenant: TENANT }, -3, 2);

    expect(mocks.rpc).toHaveBeenCalledWith("adjust_tenant_rag_usage", {
      p_tenant_id: "t-1",
      p_delta: -3,
      p_promoted_chunks_count: 2,
    });
    expect(mocks.checkState).toHaveBeenCalledWith(expect.objectContaining({
      dimension: "rag_cap",
      metric_value: 7,
      promoted_chunks_count: 2,
    }));
  });
});
