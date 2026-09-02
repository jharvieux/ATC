// §27.7 — abuse counter helpers must AWAIT the state-machine check.
//
// Regression guard for #392: the four counter helpers previously floated
// `void checkStateTransitionIfNeeded(...)`, so a serverless process reclaim
// could drop the soft/hard-cap transition after the counter advanced. The
// fix awaits the check. These tests encode the WHY: an enforcement failure
// must PROPAGATE (so the caller logs/retries it) rather than be silently
// swallowed. If anyone reverts `await` back to `void`, the rejecting-check
// cases below flip from rejecting to resolving and fail.

import { describe, it, expect, vi, beforeEach } from "vitest";

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
  incrementChatMessages,
  incrementEmailSent,
  incrementGroupInvitees,
  adjustRagChunkCount,
} from "@/lib/abuse/counters";

function makeDb() {
  return { rpc: mocks.rpc } as never;
}

const tenant = { tenant_id: "t-1" } as never;

const cases: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: "incrementChatMessages",
    run: () => incrementChatMessages({ db: makeDb(), tenant }),
  },
  {
    name: "incrementEmailSent",
    run: () => incrementEmailSent({ db: makeDb(), tenant }),
  },
  {
    name: "incrementGroupInvitees",
    run: () => incrementGroupInvitees({ db: makeDb(), tenant }, 2),
  },
  {
    name: "adjustRagChunkCount",
    run: () => adjustRagChunkCount({ db: makeDb(), tenant }, 1, 0),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.safeAwait.mockImplementation(async (_query: unknown, label: string) =>
    label === "tenant_rag_quotas.rpc.adjust"
      ? [{ current_tenant_chunks_count: 5, promoted_chunks_count: 0 }]
      : null,
  );
  mocks.rpc.mockReturnValue(Promise.resolve({ data: null, error: null }));
});

describe("abuse counters — enforcement check is awaited, not floated (#392)", () => {
  for (const c of cases) {
    it(`${c.name} propagates a state-machine failure instead of swallowing it`, async () => {
      mocks.checkState.mockRejectedValueOnce(new Error("state-machine boom"));
      await expect(c.run()).rejects.toThrow(/state-machine boom/);
      expect(mocks.checkState).toHaveBeenCalledTimes(1);
    });

    it(`${c.name} resolves and calls the check on the happy path`, async () => {
      mocks.checkState.mockResolvedValueOnce(undefined);
      await expect(c.run()).resolves.toBeUndefined();
      expect(mocks.checkState).toHaveBeenCalledTimes(1);
    });
  }
});
