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
  last_send_log_id: string | null;
}
interface LogRow { id: string; status: string; retry_of: string | null }

interface State {
  content: ContentRow[];
  emailLog: LogRow[];
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
        last_send_log_id: null,
        ...overrides,
      },
    ],
    emailLog: [{ id: "orig", status: "soft_bounced", retry_of: null }],
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
        if (op === "select") {
          const matched = target.filter(matches);
          return { data: single ? (matched[0] ?? null) : matched, error: null };
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
    state.emailLog.push({ id, status, retry_of: input.retry_of ?? null });
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
  });
});

describe("§23.7 soft-bounce retry — no duplicate send", () => {
  it("a duplicate retry event for an already-claimed attempt is skipped by the CAS claim", async () => {
    const state = makeState();
    const { deps, calls } = makeDeps(state, ["soft_bounced", "soft_bounced"]);
    const payload = { email_log_id: "orig", tenant_id: "t-1", attempt: 1 };
    const first = await runSoftBounceRetryAttempt(deps, payload);
    // Redeliver the SAME attempt-1 event (webhook double-fire / Inngest replay).
    const second = await runSoftBounceRetryAttempt(deps, payload);
    expect(first).toBe("resent");
    expect(second).toBe("claim_lost");
    expect(calls).toHaveLength(1); // exactly one send despite two events
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
