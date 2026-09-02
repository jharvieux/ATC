import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  effectsRecorded: false,
  emailSentToday: 4,
  pceSentAt: null as string | null,
  trace: [] as string[],
  db: null as unknown,
}));

vi.mock("@/inngest/client", () => ({
  inngest: {
    createFunction: (_config: unknown, handler: unknown) => {
      const run = handler as (args: Record<string, unknown>) => Promise<unknown>;
      return (args: Record<string, unknown>) => run({
        ...args,
        step: args.step ?? { run: async (_id: string, fn: () => unknown) => await fn() },
      });
    },
  },
}));

vi.mock("@/lib/db/service-role-client", () => ({
  createServiceRoleClient: () => state.db,
}));

vi.mock("@/lib/abuse/snapshot", () => ({
  PLATFORM_TENANT_ID: "00000000-0000-0000-0000-000000000000",
  loadTenantSnapshot: async () => {
    state.trace.push("snapshot");
    return {
      tenant: {
        tenant_id: "tenant-1",
        tier_code: "byo_research",
        seat_count: 1,
        billing_period: "monthly",
      },
    };
  },
}));

vi.mock("@/lib/abuse/state-machine", () => ({
  checkStateTransitionIfNeeded: async () => {
    state.trace.push("transition");
  },
}));

vi.mock("@/lib/precruise/companion-content", () => ({
  revalidateCompanionContent: () => undefined,
}));

import { precruiseGenerateAndSend } from "@/inngest/precruise-generate-and-send";

function makeDb() {
  return {
    rpc(name: string, args: Record<string, unknown>) {
      if (name === "recover_idempotent_email_send") {
        expect(args).toEqual({
          p_tenant_id: "tenant-1",
          p_idempotency_key: "pre_cruise:booking-1:t_90",
        });
        return Promise.resolve({
          data: [{
            email_log_id: "log-1",
            email_status: "sent",
            sent_at: "2026-08-31T22:00:00.000Z",
            resend_message_id: "resend-1",
            provider_first_attempt_at: "2026-08-31T21:59:59.000Z",
            provider_attempt_state: "ambiguous",
          }],
          error: null,
        });
      }
      if (name !== "finalize_idempotent_email_send") {
        throw new Error(`unexpected RPC ${name}`);
      }
      expect(args).toEqual({
        p_tenant_id: "tenant-1",
        p_idempotency_key: "pre_cruise:booking-1:t_90",
        p_resend_message_id: "resend-1",
      });
      state.trace.push("atomic-finalize");
      if (!state.effectsRecorded) {
        state.effectsRecorded = true;
        state.emailSentToday++;
      }
      return Promise.resolve({
        data: [{
          email_log_id: "log-1",
          newly_recorded: true,
          email_sent_today: state.emailSentToday,
        }],
        error: null,
      });
    },
    from(table: string) {
      if (table !== "pre_cruise_email_content") {
        throw new Error(`unexpected table ${table}`);
      }
      return {
        select() {
          const chain = {
            eq: () => chain,
            limit: () => chain,
            maybeSingle: async () => ({
              data: {
                id: "content-1",
                sent_at: state.pceSentAt,
                send_claimed_at: null,
                generated_content: { documentation_reminder: "old copy" },
                content_context_hash: "stale-context",
              },
              error: null,
            }),
          };
          return chain;
        },
        update(payload: Record<string, unknown>) {
          const chain = {
            eq: () => chain,
            is: () => chain,
            select: async () => {
              state.trace.push("pce-cas");
              state.pceSentAt = payload.sent_at as string;
              return { data: [{ id: "content-1" }], error: null };
            },
          };
          return chain;
        },
      };
    },
  };
}

beforeEach(() => {
  state.effectsRecorded = false;
  state.emailSentToday = 4;
  state.pceSentAt = null;
  state.trace = [];
  state.db = makeDb();
  vi.stubGlobal("fetch", vi.fn());
});

describe("pre-cruise recovery composition", () => {
  it("heals orphan atomic effects, runs the transition, then CAS-finalizes content", async () => {
    await (precruiseGenerateAndSend as unknown as (
      args: { event: { data: unknown } },
    ) => Promise<void>)({
      event: {
        data: {
          booking_id: "booking-1",
          tenant_id: "tenant-1",
          phase: "t_90",
          via: "direct",
        },
      },
    });

    expect(state.effectsRecorded).toBe(true);
    expect(state.emailSentToday).toBe(5);
    expect(state.pceSentAt).toBe("2026-08-31T22:00:00.000Z");
    expect(state.trace).toEqual(["atomic-finalize", "snapshot", "transition", "pce-cas"]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
