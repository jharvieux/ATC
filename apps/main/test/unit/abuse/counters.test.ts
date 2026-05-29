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
  maybeSingle: vi.fn(),
  safeAwait: vi.fn(),
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

type AnyBuilder = Record<string, (...args: unknown[]) => unknown>;

function makeDb() {
  const builder: AnyBuilder = {};
  for (const m of ["select", "eq", "order", "limit", "insert", "update", "upsert", "delete"]) {
    builder[m] = () => builder;
  }
  builder.maybeSingle = () => mocks.maybeSingle();
  builder.single = () => mocks.maybeSingle();
  return { from: () => builder } as never;
}

const tenant = { tenant_id: "t-1" } as never;

// Each helper, with the sequence of maybeSingle() reads it performs before
// it reaches the awaited checkStateTransitionIfNeeded call. (incrementEmailSent
// only reaches the check on the "existing row" branch, so its single read must
// return a row.)
const cases: Array<{ name: string; run: () => Promise<void>; reads: Array<{ data: unknown }> }> = [
  {
    name: "incrementChatMessages",
    run: () => incrementChatMessages({ db: makeDb(), tenant }),
    reads: [{ data: null }, { data: { chat_messages_count: 5 } }],
  },
  {
    name: "incrementEmailSent",
    run: () => incrementEmailSent({ db: makeDb(), tenant }),
    reads: [{ data: { id: "m1", email_sent_today: 0, email_sent_day_ref: "2000-01-01", email_sent_count: 0 } }],
  },
  {
    name: "incrementGroupInvitees",
    run: () => incrementGroupInvitees({ db: makeDb(), tenant }, 2),
    reads: [{ data: null }, { data: { group_invitees_count: 3 } }],
  },
  {
    name: "adjustRagChunkCount",
    run: () => adjustRagChunkCount({ db: makeDb(), tenant }, 1, 0),
    reads: [{ data: null }, { data: { current_tenant_chunks_count: 10 } }],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.safeAwait.mockResolvedValue(null);
});

describe("abuse counters — enforcement check is awaited, not floated (#392)", () => {
  for (const c of cases) {
    it(`${c.name} propagates a state-machine failure instead of swallowing it`, async () => {
      for (const r of c.reads) mocks.maybeSingle.mockResolvedValueOnce(r);
      mocks.checkState.mockRejectedValueOnce(new Error("state-machine boom"));
      await expect(c.run()).rejects.toThrow(/state-machine boom/);
      expect(mocks.checkState).toHaveBeenCalledTimes(1);
    });

    it(`${c.name} resolves and calls the check on the happy path`, async () => {
      for (const r of c.reads) mocks.maybeSingle.mockResolvedValueOnce(r);
      mocks.checkState.mockResolvedValueOnce(undefined);
      await expect(c.run()).resolves.toBeUndefined();
      expect(mocks.checkState).toHaveBeenCalledTimes(1);
    });
  }
});
