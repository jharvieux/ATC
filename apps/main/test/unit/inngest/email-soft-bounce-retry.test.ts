// §23.7 / #1611 — real soft-bounce retry engine.
//
// Intent pinned here:
//   - Schedule correctness: attempts sleep +6h / +12h / +24h, then a grace
//     wait before the terminal suppress judgment.
//   - Stored-content fidelity: the re-send carries the EXACT stored HTML /
//     subject / recipient / template / category (option (a)), plus a
//     deterministic per-attempt Idempotency-Key and the retry_of marker.
//   - Chain termination: delivery on an attempt stops the chain with NO
//     suppression; four consecutive soft bounces suppress the address.
//   - No-duplicate-send: a duplicate retry event for an already-claimed attempt
//     is skipped by the CAS claim (no second send).
//   - Step-boundary isolation (#1832): sendEmail and the last_send_log_id write
//     are separate memoized steps, so a transient failure recording the send
//     retries only that write — it never re-invokes the already-completed send.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Tenant is always paying (the §15.16 skip is tested separately below).
let paying = true;
vi.mock("@/lib/billing/exclude-non-paying", () => ({
  assertTenantStillPayingById: async () => (paying ? { ok: true } : { ok: false, reason: "past_grace" }),
}));

import {
  runSoftBounceRetryAttempt,
  RETRY_DELAYS_HOURS,
  TERMINAL_GRACE_HOURS,
  MAX_ATTEMPTS,
  type SoftBounceRetryPayload,
} from "@/lib/email/soft-bounce-retry";
import type { EmailSendResult, SendEmailInput } from "@/lib/email/send";

// ── in-memory DB modelling the tables the engine touches ─────────────────────

interface ContentRow {
  email_log_id: string;
  tenant_id: string;
  to_email: string;
  subject: string;
  template_id: string;
  email_category: string;
  html: string;
  reply_to: string | null;
  related_booking_id: string | null;
  related_group_id: string | null;
  user_id: string | null;
  contact_id: string | null;
  claimed_attempt: number;
  completed_attempt: number | null;
  last_send_log_id: string | null;
}
interface LogRow { id: string; tenant_id: string; status: string; retry_of: string | null }

interface State {
  content: ContentRow[];
  emailLog: LogRow[];
  emailLogFilterSets: Array<Array<[string, unknown]>>;
  emailLogSelectError: unknown;
  suppressions: Array<{ tenant_id: string; email_address: string; reason: string }>;
}

function makeState(overrides: Partial<ContentRow> = {}): State {
  return {
    content: [
      {
        email_log_id: "orig",
        tenant_id: "t-1",
        to_email: "customer@example.com",
        subject: "Your cruise awaits",
        template_id: "pre_cruise_t_7",
        email_category: "pre_cruise",
        html: "<p>Bon voyage, Alex</p>",
        reply_to: null,
        related_booking_id: "bk-1",
        related_group_id: null,
        user_id: "u-1",
        contact_id: null,
        claimed_attempt: 0,
        completed_attempt: null,
        last_send_log_id: null,
        ...overrides,
      },
    ],
    emailLog: [{ id: "orig", tenant_id: "t-1", status: "soft_bounced", retry_of: null }],
    emailLogFilterSets: [],
    emailLogSelectError: null,
    suppressions: [],
  };
}

// Minimal fluent query object over the in-memory state.
function makeDb(state: State) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let op: "select" | "update" | "delete" | "upsert" = "select";
      let payload: Record<string, unknown> | null = null;
      let wantRows = false;

      const rowsFor = (): Record<string, unknown>[] =>
        (table === "content" || table === "email_retry_content"
          ? state.content
          : table === "email_log"
            ? state.emailLog
            : table === "tenants"
              ? [{ id: "t-1", legal_name: "Test Agency", mailing_address: "123 Main St" }]
              : table === "tenant_branding"
                ? [{ tenant_id: "t-1", email_send_pattern: "platform_resend", tenant_resend_api_key_encrypted: null, email_from_address: "noreply@test.com", email_from_name: "Test", email_from_domain: null, email_from_domain_verified_at: null }]
                : table === "email_suppressions"
                  ? state.suppressions
                  : []) as unknown as Record<string, unknown>[];

      const matches = (r: Record<string, unknown>) => filters.every(([c, v]) => r[c] === v);

      const run = (single: boolean) => {
        const target = rowsFor();
        if (table === "email_log") state.emailLogFilterSets.push([...filters]);
        if (op === "select") {
          const matched = target.filter(matches);
          return {
            data: single ? (matched[0] ?? null) : matched,
            error: table === "email_log" ? state.emailLogSelectError : null,
          };
        }
        if (op === "update") {
          const matched = target.filter(matches);
          for (const r of matched) Object.assign(r, payload);
          return { data: wantRows ? matched.map((r) => ({ email_log_id: r.email_log_id })) : null, error: null };
        }
        if (op === "delete") {
          const keep = target.filter((r) => !matches(r));
          const removed = target.length - keep.length;
          target.splice(0, target.length, ...keep);
          return { data: wantRows ? new Array(removed).fill({}) : null, error: null };
        }
        // upsert
        const p = payload as { tenant_id: string; email_address: string; reason: string };
        if (!state.suppressions.some((s) => s.email_address === p.email_address && s.reason === p.reason)) {
          state.suppressions.push({ tenant_id: p.tenant_id, email_address: p.email_address, reason: p.reason });
        }
        return { data: null, error: null };
      };

      const chain: Record<string, unknown> = {
        select(_cols?: string) { if (op !== "select") wantRows = true; return chain; },
        update(p: Record<string, unknown>) { op = "update"; payload = p; return chain; },
        delete() { op = "delete"; return chain; },
        upsert(p: Record<string, unknown>) { op = "upsert"; payload = p; return chain; },
        eq(c: string, v: unknown) { filters.push([c, v]); return chain; },
        maybeSingle() { return Promise.resolve(run(true)); },
        then(resolve: (v: unknown) => unknown) { return Promise.resolve(resolve(run(false))); },
      };
      return chain;
    },
  } as unknown as SendEmailInput["db"];
}

// sendEmail stub: records inputs, appends a re-send email_log row whose status
// is drawn from a per-call queue, and returns { sent, email_log_id }.
function makeSendEmail(state: State, statuses: string[]) {
  const calls: SendEmailInput[] = [];
  let n = 0;
  const fn = vi.fn(async (input: SendEmailInput): Promise<EmailSendResult> => {
    calls.push(input);
    n += 1;
    const status = statuses[n - 1] ?? "soft_bounced";
    if (status === "suppressed") return { status: "suppressed", reason: "hard_bounce" };
    const id = `rs-${n}`;
    state.emailLog.push({ id, tenant_id: input.tenant.id, status, retry_of: input.retry_of ?? null });
    return { status: "sent", email_log_id: id, resend_message_id: `msg-${n}` };
  });
  return { fn, calls };
}

function makeDeps(state: State, sendStatuses: string[]) {
  const { fn: sendEmail, calls } = makeSendEmail(state, sendStatuses);
  const sleeps: Array<{ id: string; hours: number }> = [];
  const scheduled: SoftBounceRetryPayload[] = [];
  return {
    deps: {
      db: makeDb(state),
      sendEmail,
      sleep: async (id: string, hours: number) => { sleeps.push({ id, hours }); },
      scheduleNext: async (p: SoftBounceRetryPayload) => { scheduled.push(p); },
      // Stub does NOT model Inngest's real step.run memoization — it just calls
      // fn(). That's why the crash-resume test below still observes two sends.
      runStep: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    },
    calls,
    sleeps,
    scheduled,
  };
}

// Drives the whole chain by re-invoking with each scheduled attempt until it
// stops scheduling. Returns the ordered outcomes.
async function drive(state: State, sendStatuses: string[]) {
  const { deps, calls, sleeps, scheduled } = makeDeps(state, sendStatuses);
  const outcomes: string[] = [];
  let next: SoftBounceRetryPayload | undefined = { email_log_id: "orig", tenant_id: "t-1", attempt: 1 };
  let guard = 0;
  while (next && guard++ < 10) {
    const before = scheduled.length;
    outcomes.push(await runSoftBounceRetryAttempt(deps, next));
    next = scheduled.length > before ? scheduled[scheduled.length - 1] : undefined;
  }
  return { outcomes, calls, sleeps, scheduled, deps };
}

beforeEach(() => { paying = true; });

describe("§23.7 soft-bounce retry — schedule", () => {
  it("sleeps +6h / +12h / +24h across attempts 1-3, then a grace before the terminal check", async () => {
    const state = makeState();
    const { sleeps } = await drive(state, ["soft_bounced", "soft_bounced", "soft_bounced"]);
    const hours = sleeps.map((s) => s.hours);
    expect(hours).toEqual([
      RETRY_DELAYS_HOURS[0], // 6
      RETRY_DELAYS_HOURS[1], // 12
      RETRY_DELAYS_HOURS[2], // 24
      TERMINAL_GRACE_HOURS, // grace before suppress judgment
    ]);
  });
});

describe("§23.7 soft-bounce retry — stored-content fidelity", () => {
  it("re-sends the EXACT stored html/subject/recipient/template/category verbatim (option a)", async () => {
    const state = makeState();
    const { calls } = await drive(state, ["delivered"]); // attempt 1 delivers
    expect(calls).toHaveLength(1);
    const sent = calls[0]!;
    expect(sent.html).toBe("<p>Bon voyage, Alex</p>");
    expect(sent.subject).toBe("Your cruise awaits");
    expect(sent.to).toBe("customer@example.com");
    expect(sent.template_id).toBe("pre_cruise_t_7");
    expect(sent.category).toBe("pre_cruise");
    expect(sent.related_booking_id).toBe("bk-1");
    expect(sent.user_id).toBe("u-1");
    // deterministic per-attempt key (D-091 #23) + re-send marker (no new chain)
    expect(sent.idempotencyKey).toBe("soft-retry:orig:1");
    expect(sent.retry_of).toBe("orig");
  });
});

describe("§23.7 soft-bounce retry — termination", () => {
  it("aborts before sending or mutating state when the terminal-status read fails", async () => {
    const state = makeState();
    state.emailLogSelectError = { code: "XX000", message: "read failed" };
    const { deps, calls } = makeDeps(state, ["delivered"]);

    await expect(runSoftBounceRetryAttempt(
      deps,
      { email_log_id: "orig", tenant_id: "t-1", attempt: 1 },
    )).rejects.toThrow("email_log terminal status lookup failed");

    expect(calls).toHaveLength(0);
    expect(state.emailLog).toEqual([
      { id: "orig", tenant_id: "t-1", status: "soft_bounced", retry_of: null },
    ]);
    expect(state.content[0]?.claimed_attempt).toBe(0);
    expect(state.suppressions).toHaveLength(0);
  });

  it("delivery on attempt 2 stops the chain with NO suppression", async () => {
    const state = makeState();
    // attempt 1 re-send bounces, attempt 2 re-send delivers.
    const { outcomes, calls } = await drive(state, ["soft_bounced", "delivered"]);
    // Two real re-sends (attempts 1 & 2); attempt 3 sees rs-2 delivered → stop.
    expect(calls).toHaveLength(2);
    expect(outcomes[outcomes.length - 1]).toBe("already_terminated");
    expect(state.suppressions).toHaveLength(0);
    // content purged on termination
    expect(state.content).toHaveLength(0);
  });

  it("four consecutive soft bounces suppress the address as a hard bounce", async () => {
    const state = makeState();
    const { outcomes, calls } = await drive(state, ["soft_bounced", "soft_bounced", "soft_bounced"]);
    expect(calls).toHaveLength(3); // three re-sends (attempts 1-3)
    expect(outcomes[outcomes.length - 1]).toBe("suppressed_terminal");
    expect(state.suppressions).toEqual([
      { tenant_id: "t-1", email_address: "customer@example.com", reason: "hard_bounce" },
    ]);
    // original marked hard_bounced; content purged
    expect(state.emailLog.find((r) => r.id === "orig")!.status).toBe("hard_bounced");
    expect(state.content).toHaveLength(0);
    expect(state.emailLogFilterSets.length).toBeGreaterThan(0);
    expect(state.emailLogFilterSets.every((filters) =>
      filters.some(([column, value]) => column === "tenant_id" && value === "t-1")
    )).toBe(true);
  });
});

describe("§23.7 soft-bounce retry — terminal write ordering (crash recovery)", () => {
  // Wraps a db so the FIRST email_log UPDATE (the terminal status flip) fails once,
  // simulating a crash in the window between the two terminal writes.
  function dbWithOneEmailLogUpdateFailure(state: State) {
    const base = makeDb(state) as unknown as { from: (t: string) => Record<string, unknown> };
    let failNext = true;
    return {
      from(table: string) {
        const chain = base.from(table);
        if (table !== "email_log") return chain;
        let isUpdate = false;
        const origUpdate = (chain.update as (p: unknown) => unknown).bind(chain);
        chain.update = (p: unknown) => {
          isUpdate = true;
          return origUpdate(p);
        };
        const origThen = (chain.then as (r: (v: unknown) => unknown) => unknown).bind(chain);
        chain.then = (resolve: (v: unknown) => unknown) => {
          if (isUpdate && failNext) {
            failNext = false;
            return Promise.resolve(
              resolve({
                data: null,
                error: { message: "simulated crash", code: "XX000", hint: null, details: null, name: "e" },
              }),
            );
          }
          return origThen(resolve);
        };
        return chain;
      },
    } as unknown as SendEmailInput["db"];
  }

  // The terminal branch short-circuits on isTerminalStatus(email_log_id): once the
  // status is flipped to hard_bounced, a re-run returns already_terminated and the
  // suppression upsert would never run again. So the suppression MUST be written
  // BEFORE the status flip. This test crashes the status flip and proves (a) the
  // suppression already landed, and (b) the retry completes both writes. The
  // inverse — status flipped but suppression missing — is impossible by
  // construction, because suppression is the first of the two writes.
  it("suppression persists when the terminal status flip crashes; the retry completes both", async () => {
    const state = makeState();
    const db = dbWithOneEmailLogUpdateFailure(state);
    const { fn: sendEmail } = makeSendEmail(state, ["soft_bounced", "soft_bounced", "soft_bounced"]);
    const deps = {
      db,
      sendEmail,
      sleep: async () => {},
      scheduleNext: async () => {},
      runStep: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    };
    const run = (attempt: number) =>
      runSoftBounceRetryAttempt(deps, { email_log_id: "orig", tenant_id: "t-1", attempt });

    // Drive attempts 1-3 (three soft bounces) up to the terminal judgment.
    await run(1);
    await run(2);
    await run(3);

    // Terminal attempt: suppression upsert succeeds, then the status flip crashes.
    await expect(run(MAX_ATTEMPTS + 1)).rejects.toThrow();
    expect(state.suppressions).toEqual([
      { tenant_id: "t-1", email_address: "customer@example.com", reason: "hard_bounce" },
    ]);
    // Status NOT yet flipped → a retry still enters the terminal branch (not short-circuited).
    expect(state.emailLog.find((r) => r.id === "orig")!.status).toBe("soft_bounced");

    // Retry the terminal attempt — the flip now succeeds; both writes are idempotent.
    const outcome = await run(MAX_ATTEMPTS + 1);
    expect(outcome).toBe("suppressed_terminal");
    expect(state.emailLog.find((r) => r.id === "orig")!.status).toBe("hard_bounced");
    expect(state.suppressions).toHaveLength(1); // upsert idempotent — no duplicate suppression
  });
});

describe("§23.7 soft-bounce retry — duplicate delivery & crash-after-claim resume", () => {
  // The CAS claim ORDERS attempts; completed_attempt is the completion marker that
  // decides what a zero-row claim means. A duplicate of an attempt that already ran
  // to completion (completed_attempt >= attempt) must return claim_lost WITHOUT
  // re-sending — a re-send would insert an orphaned email_log row and bump the sent
  // counter, neither of which the Resend Idempotency-Key dedupes (it dedupes only
  // the vendor delivery). This is the round-2 audit fix: the old re-entrant path
  // re-ran sendEmail on every such duplicate.
  it("a completed attempt's duplicate event returns claim_lost with NO second send", async () => {
    const state = makeState();
    const { deps, calls } = makeDeps(state, ["soft_bounced", "soft_bounced"]);
    const payload = { email_log_id: "orig", tenant_id: "t-1", attempt: 1 };
    const first = await runSoftBounceRetryAttempt(deps, payload);
    // Redeliver the SAME attempt-1 event AFTER it fully completed.
    const second = await runSoftBounceRetryAttempt(deps, payload);
    expect(first).toBe("resent");
    expect(second).toBe("claim_lost");
    // Exactly one real send — the completion marker stops the orphaned re-send.
    expect(calls).toHaveLength(1);
    expect(state.content[0]!.completed_attempt).toBe(1);
  });

  // Finding 2 — the crash this re-entrancy exists to survive. A run advances the
  // claim, re-sends, then the process dies before scheduleNext fires. The Inngest
  // re-run of the same event must resume and STILL schedule attempt+1, or the
  // escalation is silently dropped. Intent: escalation is never lost to a crash
  // in the post-claim window.
  it("resumes a crash after the claim and still schedules the next attempt", async () => {
    const state = makeState();
    const { fn: sendEmail, calls } = makeSendEmail(state, ["soft_bounced", "soft_bounced"]);
    const scheduled: SoftBounceRetryPayload[] = [];
    let scheduleShouldCrash = true;
    const deps = {
      db: makeDb(state),
      sendEmail,
      sleep: async () => {},
      scheduleNext: async (p: SoftBounceRetryPayload) => {
        if (scheduleShouldCrash) {
          scheduleShouldCrash = false;
          throw new Error("simulated crash after claim, before scheduleNext");
        }
        scheduled.push(p);
      },
      // This stub does not model real Inngest step.run memoization (see #1832) —
      // it just invokes fn() every call. That's WHY run 2 below still re-sends:
      // in production, step.run's memoized result would short-circuit the second
      // sendEmail call for the same attempt; the pure-logic unit test can't
      // observe that production-only guarantee, so the accepted trade-off here
      // is a duplicate real send on this crash-resume path, pinned below.
      runStep: async <T>(_id: string, fn: () => Promise<T>) => fn(),
    };
    const payload = { email_log_id: "orig", tenant_id: "t-1", attempt: 1 };

    // Run 1: claim advances to 1, the re-send lands, then scheduleNext crashes.
    await expect(runSoftBounceRetryAttempt(deps, payload)).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(state.content[0]!.claimed_attempt).toBe(1); // claim already advanced
    expect(scheduled).toHaveLength(0); // next attempt NOT yet scheduled

    // Run 2 (Inngest re-run of the same event): the CAS predicate no longer matches
    // (claimed_attempt is 1, not 0), but the re-entrant resume detects this exact
    // attempt is already claimed and completes the post-claim bookkeeping.
    const outcome = await runSoftBounceRetryAttempt(deps, payload);
    expect(outcome).toBe("resent");
    expect(scheduled).toEqual([{ email_log_id: "orig", tenant_id: "t-1", attempt: 2 }]);
    // Accepted trade-off (#1832): this test's runStep stub doesn't memoize, so
    // resume re-invokes sendEmail — two real sends total. In production the
    // step.run boundary memoizes the first send and this stays at one. Pinned
    // so a refactor that makes resume a silent no-op (0 further calls) or a
    // triple-send fails loudly instead of drifting unnoticed.
    expect(calls).toHaveLength(2);
  });
});

describe("§23.7 soft-bounce retry — step-boundary retries (#1832)", () => {
  // The audit finding this closes: sendEmail and the last_send_log_id write
  // used to share ONE step.run boundary. safeAwait throws on a transient DB
  // error writing the record, which escaped that shared step — so a real
  // Inngest step-retry would re-invoke sendEmail too, orphaning a duplicate
  // email_log row + counter bump. They're now two separate memoized steps, so
  // a record failure retries only the record step; the send step, once it has
  // completed, is memoized and is never re-invoked. Unlike the other tests in
  // this file (whose runStep stub deliberately does NOT memoize, to pin a
  // different documented trade-off), this test's stub DOES memoize by id —
  // that's the only way to observe this guarantee.
  function dbWithOneLastSendLogIdUpdateFailure(state: State) {
    const base = makeDb(state) as unknown as { from: (t: string) => Record<string, unknown> };
    let failNext = true;
    return {
      from(table: string) {
        const chain = base.from(table);
        if (table !== "email_retry_content") return chain;
        let isTargetUpdate = false;
        const origUpdate = (chain.update as (p: Record<string, unknown>) => unknown).bind(chain);
        chain.update = (p: Record<string, unknown>) => {
          isTargetUpdate = "last_send_log_id" in p;
          return origUpdate(p);
        };
        const origThen = (chain.then as (r: (v: unknown) => unknown) => unknown).bind(chain);
        chain.then = (resolve: (v: unknown) => unknown) => {
          if (isTargetUpdate && failNext) {
            failNext = false;
            return Promise.resolve(
              resolve({
                data: null,
                error: { message: "simulated transient DB error", code: "XX000", hint: null, details: null, name: "e" },
              }),
            );
          }
          return origThen(resolve);
        };
        return chain;
      },
    } as unknown as SendEmailInput["db"];
  }

  it("a transient failure recording last_send_log_id retries ONLY the record step, not sendEmail", async () => {
    const state = makeState();
    const db = dbWithOneLastSendLogIdUpdateFailure(state);
    const { fn: sendEmail, calls } = makeSendEmail(state, ["soft_bounced"]);
    const memo = new Map<string, unknown>();
    const runStep = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      if (memo.has(id)) return memo.get(id) as T;
      const result = await fn();
      memo.set(id, result);
      return result;
    };
    const deps = { db, sendEmail, sleep: async () => {}, scheduleNext: async () => {}, runStep };
    const payload = { email_log_id: "orig", tenant_id: "t-1", attempt: 1 };

    // Function-level retry 1: the send step succeeds; the record step throws.
    await expect(runSoftBounceRetryAttempt(deps, payload)).rejects.toThrow();
    expect(calls).toHaveLength(1);

    // Function-level retry 2 (Inngest re-invokes the whole function): the send
    // step is memoized (no second sendEmail call); the record step re-runs and
    // this time succeeds.
    const outcome = await runSoftBounceRetryAttempt(deps, payload);
    expect(outcome).toBe("resent");
    expect(calls).toHaveLength(1); // still one — the memoized send was never re-invoked
    expect(state.content[0]!.last_send_log_id).toBe("rs-1");
  });
});

describe("§23.7 soft-bounce retry — guards", () => {
  it("skips a past-grace tenant without sending (§15.16)", async () => {
    paying = false;
    const state = makeState();
    const { deps, calls } = makeDeps(state, ["delivered"]);
    const outcome = await runSoftBounceRetryAttempt(deps, { email_log_id: "orig", tenant_id: "t-1", attempt: 1 });
    expect(outcome).toBe("skipped_past_grace");
    expect(calls).toHaveLength(0);
  });

  it("returns no_content (no send) when the stored payload is gone (expired/purged)", async () => {
    const state = makeState();
    state.content.splice(0, state.content.length); // simulate purged content
    const { deps, calls } = makeDeps(state, ["delivered"]);
    const outcome = await runSoftBounceRetryAttempt(deps, { email_log_id: "orig", tenant_id: "t-1", attempt: 1 });
    expect(outcome).toBe("no_content");
    expect(calls).toHaveLength(0);
  });
});
