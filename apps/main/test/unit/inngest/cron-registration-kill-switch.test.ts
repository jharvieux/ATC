// Registration-level kill switches (#894): when BOOKING_CRONS_DISABLED /
// SUBHOSTING_CRONS_DISABLED are set, the cron-triggered functions of the
// deferred feature must be EXCLUDED from serve() — an in-handler guard alone
// would leave the cron firing (and billing an Inngest execution) every tick.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("inngest/next", () => ({
  serve: (config: { functions: Array<{ id: () => string }> }) => ({
    GET: config,
    POST: config,
    PUT: config,
  }),
}));

const BOOKING_CRON_IDS = [
  "payouts-mark-available",
  "payouts-reconcile-processing",
  "bookings-stuck-submitting-reconcile",
  "reconcile-statement-automated",
  "pre-cruise-email-scheduler-t1",
  "pre-cruise-email-scheduler-multiphase",
  "booking-commission-retention-purge",
];
const SUBHOSTING_CRON_IDS = ["custom-domain-reverify", "custom-domain-txt-grace-sweep"];
// Event-driven booking functions stay registered regardless of the flag —
// idle triggers cost nothing and their in-handler guards still apply.
const EVENT_DRIVEN_BOOKING_IDS = ["payouts-execute-transfer", "commission-split-on-received"];
// Unrelated functions that must stay registered no matter which flags are set —
// guards against a refactor of the conditional spreads swallowing neighbors.
const ALWAYS_REGISTERED_IDS = [
  "compliance-nightly",
];

async function loadRegisteredIds(): Promise<string[]> {
  vi.resetModules();
  const route = await import("@/app/api/inngest/route");
  const config = route.GET as unknown as { functions: Array<{ id: () => string }> };
  return config.functions.map((f) => f.id());
}

const ORIG_BOOKING = process.env.BOOKING_CRONS_DISABLED;
const ORIG_SUBHOSTING = process.env.SUBHOSTING_CRONS_DISABLED;

afterEach(() => {
  if (ORIG_BOOKING === undefined) delete process.env.BOOKING_CRONS_DISABLED;
  else process.env.BOOKING_CRONS_DISABLED = ORIG_BOOKING;
  if (ORIG_SUBHOSTING === undefined) delete process.env.SUBHOSTING_CRONS_DISABLED;
  else process.env.SUBHOSTING_CRONS_DISABLED = ORIG_SUBHOSTING;
});

describe("cron registration kill switches", () => {
  it("registers all gated functions when both flags are unset", async () => {
    delete process.env.BOOKING_CRONS_DISABLED;
    delete process.env.SUBHOSTING_CRONS_DISABLED;
    const ids = await loadRegisteredIds();
    for (const id of [...BOOKING_CRON_IDS, ...SUBHOSTING_CRON_IDS, ...EVENT_DRIVEN_BOOKING_IDS]) {
      expect(ids).toContain(id);
    }
  });

  it("BOOKING_CRONS_DISABLED=true unregisters booking crons but keeps event-driven booking functions", async () => {
    process.env.BOOKING_CRONS_DISABLED = "true";
    delete process.env.SUBHOSTING_CRONS_DISABLED;
    const ids = await loadRegisteredIds();
    for (const id of BOOKING_CRON_IDS) expect(ids).not.toContain(id);
    for (const id of EVENT_DRIVEN_BOOKING_IDS) expect(ids).toContain(id);
    for (const id of SUBHOSTING_CRON_IDS) expect(ids).toContain(id);
    for (const id of ALWAYS_REGISTERED_IDS) expect(ids).toContain(id);
  });

  it("SUBHOSTING_CRONS_DISABLED=true unregisters custom-domain crons only", async () => {
    delete process.env.BOOKING_CRONS_DISABLED;
    process.env.SUBHOSTING_CRONS_DISABLED = "true";
    const ids = await loadRegisteredIds();
    for (const id of SUBHOSTING_CRON_IDS) expect(ids).not.toContain(id);
    for (const id of BOOKING_CRON_IDS) expect(ids).toContain(id);
    for (const id of ALWAYS_REGISTERED_IDS) expect(ids).toContain(id);
  });
});
