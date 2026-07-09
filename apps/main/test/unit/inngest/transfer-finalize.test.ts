// §11.6 — transfer-finalize idempotency + CAS + exactly-once side effects (#1592).
//
// Three invariants this pins:
//   1. CAS commit: if undo cleared transfer_soft_commit_at between the memoized
//      read step and the commit step, the guarded UPDATE matches zero rows and
//      the function no-ops instead of committing a reverted transfer.
//   2. Exactly-once side effects across a retry: when the commit lands but a
//      later step (contact bind) throws, Inngest replays the memoized read +
//      commit + memory-emit steps (no double-commit, no double-emit) and only
//      re-runs the failed bind step. This is the defect: pre-fix, a retry
//      re-read a committed row, early-returned "already_committed", and dropped
//      memory extraction + contact binding entirely.
//   3. A genuinely-committed session (duplicate event, fresh invocation) short-
//      circuits to already_committed with no side effects.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Override createFunction so we can invoke the handler directly (codebase
// convention — see onboarding-stale-suspend.test.ts).
vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (config: unknown, handler: unknown) => ({ __config: config, __handler: handler }),
  },
}));

const TENANT_ID = "tenant-uuid";
const USER_ID = "user-uuid";
const ANON_SESSION_ID = "anon-session-uuid";
const CONV_ID = "conv-uuid";
// Per-attempt marker threaded through the finalize event (#1655). Fixed so the
// event's marker and the session row's transfer_soft_commit_at line up in the
// tests that should proceed; the supersede test deliberately diverges them.
const SOFT_COMMIT_AT = "2026-07-09T00:00:00.000Z";

const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
  db: { current: null as unknown },
}));

vi.mock("@/lib/db/factories", () => ({
  tenantContextFromInngestEvent: () => ({
    tenant_id: TENANT_ID,
    source: { kind: "inngest", event_id: "evt-1" },
  }),
}));
vi.mock("@/lib/db/tenant-client", () => ({
  tenantClient: () => mocks.db.current,
}));
vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => ({}),
}));
vi.mock("@/lib/attribution/bind-contact-on-identification", () => ({
  bindContactOnIdentification: (...args: unknown[]) => mocks.bind(...args),
}));

type QueryResult = { data: unknown; error: unknown };

function chain(
  awaitResult: () => QueryResult,
  singleResult?: () => QueryResult,
): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  for (const m of ["eq", "is", "not", "in", "order", "select"]) c[m] = () => c;
  c.maybeSingle = async () => (singleResult ?? awaitResult)();
  const promise = () => Promise.resolve(awaitResult());
  c.then = (res: (v: QueryResult) => unknown, rej?: (e: unknown) => unknown) =>
    promise().then(res, rej);
  c.catch = (rej: (e: unknown) => unknown) => promise().catch(rej);
  return c;
}

function buildFinalizeDb(opts: {
  sessionRow: Record<string, unknown> | null;
  commitRows: { id: string }[];
  convRows: { id: string }[];
  // Returned by the commit-step re-read (the 2nd+ maybeSingle on
  // anonymous_sessions), modeling the row's state after a raced undo or a
  // crash-window self-recommit. Falls back to sessionRow.
  reReadRow?: Record<string, unknown> | null;
  // If set, the commit UPDATE resolves this error → safeAwaitRowCount throws a
  // non-ROW_COUNT_MISMATCH SupabaseMutationError → handler must re-throw.
  commitError?: { message: string; code?: string };
  onCommitUpdate?: () => void;
}): unknown {
  let sessionSelectCalls = 0;
  return {
    from: (table: string) => {
      if (table === "anonymous_sessions") {
        return {
          select: () =>
            chain(
              () => ({ data: opts.sessionRow ? [opts.sessionRow] : [], error: null }),
              () => {
                sessionSelectCalls += 1;
                const row =
                  sessionSelectCalls === 1 ? opts.sessionRow : opts.reReadRow ?? opts.sessionRow;
                return { data: row, error: null };
              },
            ),
          update: () => {
            opts.onCommitUpdate?.();
            return chain(() =>
              opts.commitError
                ? { data: null, error: opts.commitError }
                : { data: opts.commitRows, error: null },
            );
          },
        };
      }
      if (table === "conversations") {
        return { select: () => chain(() => ({ data: opts.convRows, error: null })) };
      }
      return { select: () => chain(() => ({ data: null, error: null })) };
    },
  };
}

// Models Inngest step memoization: a completed step is cached by id and
// replayed on retry without re-running; a step whose fn throws is NOT cached,
// so it re-runs on the next invocation with the same step instance.
function makeStep(): {
  step: { run: unknown; sendEvent: unknown };
  emitted: Array<{ id: string; events: unknown }>;
} {
  const memo = new Map<string, unknown>();
  const emitted: Array<{ id: string; events: unknown }> = [];
  return {
    emitted,
    step: {
      run: async (id: string, fn: () => Promise<unknown>) => {
        if (memo.has(id)) return memo.get(id);
        const result = await fn();
        memo.set(id, result);
        return result;
      },
      sendEvent: async (id: string, events: unknown) => {
        if (memo.has(id)) return memo.get(id);
        emitted.push({ id, events });
        memo.set(id, undefined);
        return undefined;
      },
    },
  };
}

async function loadFinalize(): Promise<{
  __config: { idempotency?: string };
  __handler: (arg: unknown) => Promise<unknown>;
}> {
  const mod = (await import("@/inngest/transfer-finalize")) as unknown as {
    transferFinalize: { __config: { idempotency?: string }; __handler: (arg: unknown) => Promise<unknown> };
  };
  return mod.transferFinalize;
}

async function runHandler(step: unknown, eventSoftCommitAt: string | undefined = SOFT_COMMIT_AT): Promise<unknown> {
  const fn = await loadFinalize();
  return fn.__handler({
    event: {
      id: "evt-1",
      name: "anonymous_session.transfer_finalize",
      data: {
        anonymous_session_id: ANON_SESSION_ID,
        user_id: USER_ID,
        tenant_id: TENANT_ID,
        transfer_soft_commit_at: eventSoftCommitAt,
      },
    },
    step,
  });
}

const softCommittedSession = () => ({
  id: ANON_SESSION_ID,
  tenant_id: TENANT_ID,
  transferred_to_user_id: USER_ID,
  transfer_soft_commit_at: SOFT_COMMIT_AT,
  transfer_committed_at: null,
});

beforeEach(() => {
  mocks.bind.mockReset();
});

describe("transferFinalize — happy path", () => {
  it("commits, emits memory extraction once, and binds the contact once", async () => {
    mocks.db.current = buildFinalizeDb({
      sessionRow: softCommittedSession(),
      commitRows: [{ id: ANON_SESSION_ID }],
      convRows: [{ id: CONV_ID }],
    });
    mocks.bind.mockResolvedValue({ ok: true, contact_id: "c1", was_new_contact: true });

    const { step, emitted } = makeStep();
    const result = await runHandler(step);

    expect(result).toMatchObject({
      status: "committed",
      conversations_transferred: 1,
      contact_id: "c1",
      contact_was_new: true,
    });
    expect(emitted.filter((e) => e.id === "emit-memory-extractions")).toHaveLength(1);
    expect(mocks.bind).toHaveBeenCalledTimes(1);
  });
});

describe("transferFinalize — CAS race with undo (defect 2)", () => {
  it("no-ops without side effects when undo cleared the soft-commit (CAS zero rows)", async () => {
    // Read step saw a soft-committed session, but undo cleared
    // transfer_soft_commit_at before the commit step ran → CAS zero rows, and
    // the disambiguating re-read sees soft_commit now null → true undo.
    mocks.db.current = buildFinalizeDb({
      sessionRow: softCommittedSession(),
      commitRows: [], // CAS matched nothing
      reReadRow: {
        transfer_committed_at: null,
        transfer_soft_commit_at: null, // undo cleared it
        transferred_to_user_id: null,
      },
      convRows: [{ id: CONV_ID }],
    });

    const { step, emitted } = makeStep();
    const result = await runHandler(step);

    expect(result).toEqual({ status: "undone_noop" });
    expect(emitted).toHaveLength(0);
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("PROCEEDS to side effects when the CAS zero-row is a crash-window self-recommit", async () => {
    // Intra-step crash: a prior execution of commit-transfer set
    // transfer_committed_at but Inngest died before acking the step, so the
    // retry re-ran the body → CAS zero rows. The re-read shows the row is
    // committed to OUR user with soft_commit still set → self-recommit, NOT an
    // undo. Side effects must still run (defect 3 through the crash window).
    mocks.db.current = buildFinalizeDb({
      sessionRow: softCommittedSession(),
      commitRows: [], // already committed by the prior partial run → 0 rows now
      reReadRow: {
        transfer_committed_at: new Date().toISOString(),
        transfer_soft_commit_at: SOFT_COMMIT_AT, // same attempt as our event
        transferred_to_user_id: USER_ID,
      },
      convRows: [{ id: CONV_ID }],
    });
    mocks.bind.mockResolvedValue({ ok: true, contact_id: "c1", was_new_contact: false });

    const { step, emitted } = makeStep();
    const result = await runHandler(step);

    expect(result).toMatchObject({ status: "committed", contact_id: "c1" });
    expect(emitted.filter((e) => e.id === "emit-memory-extractions")).toHaveLength(1);
    expect(mocks.bind).toHaveBeenCalledTimes(1);
  });

  it("re-throws a non-ROW_COUNT_MISMATCH commit error so Inngest retries (no silent skip)", async () => {
    mocks.db.current = buildFinalizeDb({
      sessionRow: softCommittedSession(),
      commitRows: [],
      commitError: { message: "connection reset", code: "57P01" },
      convRows: [{ id: CONV_ID }],
    });

    const { step, emitted } = makeStep();
    await expect(runHandler(step)).rejects.toThrow(/connection reset/);
    expect(emitted).toHaveLength(0);
    expect(mocks.bind).not.toHaveBeenCalled();
  });
});

describe("transferFinalize — exactly-once side effects across retry (defect 3)", () => {
  it("re-runs only the failed bind step; commit + memory-emit stay memoized", async () => {
    let commitUpdateCount = 0;
    mocks.db.current = buildFinalizeDb({
      sessionRow: softCommittedSession(),
      commitRows: [{ id: ANON_SESSION_ID }],
      convRows: [{ id: CONV_ID }],
      onCommitUpdate: () => {
        commitUpdateCount += 1;
      },
    });
    // First bind attempt fails (throws inside the step → whole run retries),
    // second attempt succeeds.
    mocks.bind
      .mockResolvedValueOnce({ ok: false, error: "attribution_touch_failed" })
      .mockResolvedValueOnce({ ok: true, contact_id: "c1", was_new_contact: false });

    const { step, emitted } = makeStep();

    // Run 1 — commit lands, memory emits, bind throws → handler throws.
    await expect(runHandler(step)).rejects.toThrow(/attribution_touch_failed/);
    expect(emitted.filter((e) => e.id === "emit-memory-extractions")).toHaveLength(1);
    expect(commitUpdateCount).toBe(1);

    // Run 2 (retry, same step instance) — read/commit/memory replay from memo,
    // only bind re-runs and now succeeds.
    const result = await runHandler(step);
    expect(result).toMatchObject({ status: "committed", contact_id: "c1" });

    // The defect: memory extraction must NOT be emitted twice, and the commit
    // must NOT run twice — both are memoized. Only bind re-ran.
    expect(emitted.filter((e) => e.id === "emit-memory-extractions")).toHaveLength(1);
    expect(commitUpdateCount).toBe(1);
    expect(mocks.bind).toHaveBeenCalledTimes(2);
  });
});

describe("transferFinalize — per-attempt idempotency + supersede (#1655)", () => {
  it("keys idempotency on the soft-commit attempt marker, not the bare session id", async () => {
    // Encodes WHY: a plain anonymous_session_id key would collapse a legitimate
    // undo→re-commit (a new finalize for the same session) into the first run's
    // dedup window and silently drop it. Including transfer_soft_commit_at makes
    // each attempt its own key while still deduping concurrent duplicate runs of
    // the SAME attempt.
    const fn = await loadFinalize();
    expect(fn.__config.idempotency).toContain("event.data.anonymous_session_id");
    expect(fn.__config.idempotency).toContain("event.data.transfer_soft_commit_at");
  });

  it("supersedes a stale attempt: an older finalize event no-ops once a newer soft-commit overwrote the marker", async () => {
    // A user undid and re-committed: the row's transfer_soft_commit_at advanced
    // to a NEWER value, but this event was scheduled for the OLD attempt. The
    // marker-gated commit CAS matches zero rows, and the re-read must NOT
    // misclassify the newer live attempt as our own self-recommit → no commit,
    // no double memory-emit / double contact-bind.
    mocks.db.current = buildFinalizeDb({
      sessionRow: {
        id: ANON_SESSION_ID,
        tenant_id: TENANT_ID,
        transferred_to_user_id: USER_ID,
        transfer_soft_commit_at: "2026-07-09T05:00:00.000Z", // newer than our event
        transfer_committed_at: null,
      },
      commitRows: [], // marker mismatch → CAS zero rows
      reReadRow: {
        transfer_committed_at: null,
        transfer_soft_commit_at: "2026-07-09T05:00:00.000Z",
        transferred_to_user_id: USER_ID,
      },
      convRows: [{ id: CONV_ID }],
    });

    const { step, emitted } = makeStep();
    const result = await runHandler(step, SOFT_COMMIT_AT); // our event = OLD attempt

    expect(result).toEqual({ status: "undone_noop" });
    expect(emitted).toHaveLength(0);
    expect(mocks.bind).not.toHaveBeenCalled();
  });
});

describe("transferFinalize — duplicate event (already committed)", () => {
  it("short-circuits to already_committed with no side effects", async () => {
    mocks.db.current = buildFinalizeDb({
      sessionRow: {
        ...softCommittedSession(),
        transfer_committed_at: new Date().toISOString(),
      },
      commitRows: [{ id: ANON_SESSION_ID }],
      convRows: [{ id: CONV_ID }],
    });

    const { step, emitted } = makeStep();
    const result = await runHandler(step);

    expect(result).toEqual({ status: "already_committed" });
    expect(emitted).toHaveLength(0);
    expect(mocks.bind).not.toHaveBeenCalled();
  });
});
