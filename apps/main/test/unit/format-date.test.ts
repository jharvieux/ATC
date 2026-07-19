// Unit tests for the canonical date-display helper — #1610.
//
// Property under test: formatDate always uses an explicit locale ("en-US"),
// so it can never produce ambient-locale output that would differ between
// SSR and the browser (the hydration-mismatch bug this consolidation fixes).
//
// Dates are built via the local-time Date constructor (new Date(y, m, d)),
// not an ISO UTC string — parsing "...Z" and rendering with
// toLocaleDateString (which uses the runtime's local timezone) would shift
// the displayed day whenever the CI runner's TZ has a negative UTC offset.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { formatDate } from "@/lib/format-date";

const __dirname = dirname(fileURLToPath(import.meta.url));

const JAN_5_2026 = new Date(2026, 0, 5); // Monday

describe("formatDate", () => {
  it("defaults to numeric en-US format", () => {
    expect(formatDate(JAN_5_2026)).toBe("1/5/2026");
  });

  it("short style omits the year", () => {
    expect(formatDate(JAN_5_2026, "short")).toBe("Jan 5");
  });

  it("medium style includes month, day, and year", () => {
    expect(formatDate(JAN_5_2026, "medium")).toBe("Jan 5, 2026");
  });

  it("long style includes the weekday", () => {
    expect(formatDate(JAN_5_2026, "long")).toBe("Monday, January 5");
  });

  it("returns an em dash for null/undefined", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate(undefined)).toBe("—");
  });

  it("returns an em dash for an invalid date string", () => {
    expect(formatDate("not-a-date")).toBe("—");
  });

  it("accepts an ISO date string", () => {
    expect(formatDate("2026-01-05T12:00:00")).toBe("1/5/2026");
  });

  it("accepts an epoch-milliseconds number (Stripe timestamp * 1000 pattern)", () => {
    expect(formatDate(JAN_5_2026.getTime())).toBe("1/5/2026");
  });

  // #1768: a date-only column (e.g. sailing_date, a Postgres DATE) parses as
  // UTC midnight. Rendering it in the browser's local timezone rolls a
  // negative-UTC-offset browser back to the previous calendar day — the
  // sailing date shown wouldn't match the sailing date stored. Pin the fix
  // by rendering under a real negative-offset zone (UTC-10) so the test
  // fails if the UTC-anchoring regresses.
  //
  // #1999: this used to flip `process.env.TZ` in beforeEach/afterEach to
  // simulate the negative-offset zone. That's not hermetic — Node only
  // invalidates V8's cached ICU timezone on env-var writes made on the main
  // thread; under Stryker's vitest-runner (worker_threads pool) the
  // reassignment silently no-ops and the suite's result instead tracks
  // whatever TZ the *process* was launched with. formatDate's optional
  // `timeZone` param sidesteps ambient TZ entirely, so the test is
  // deterministic under every pool model and launch TZ.
  describe("date-only strings under a negative-UTC-offset timezone", () => {
    it("renders the same calendar date as stored, not the day before", () => {
      expect(formatDate("2026-07-06", "medium")).toBe("Jul 6, 2026");
      expect(formatDate("2026-07-06", "numeric")).toBe("7/6/2026");
    });

    it("still renders full timestamps in local time (not forced to UTC)", () => {
      // A genuine instant (has a time component) should keep local-time
      // rendering — only bare date-only strings get UTC-anchored. 5am UTC
      // is still July 5 in UTC-10; if the fix over-broadly forced every
      // input to UTC, this would wrongly render July 6.
      expect(formatDate("2026-07-06T05:00:00Z", "numeric", "Pacific/Honolulu")).toBe("7/5/2026");
    });
  });

  // #1999 traded away coverage of the DEFAULT (no-override) branch under a
  // negative-UTC-offset ambient timezone — every assertion above passes an
  // explicit `timeZone`, so a regression in the fallback-to-ambient-TZ path
  // (the `: STYLE_OPTIONS[style]` branch in format-date.ts) would go
  // uncaught. Reassigning process.env.TZ mid-test doesn't work here (that's
  // exactly the hermeticity bug #1999 fixed — see the module comment above);
  // the only reliable way to control ambient TZ is to set it at process
  // boot. Shell out to a child process launched with TZ=Pacific/Honolulu.
  it("falls back to the ambient TZ when no override is passed (boot-TZ subprocess)", () => {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", join(__dirname, "../fixtures/format-date-boot-tz-probe.ts")],
      // timeout: vitest's testTimeout can't preempt a blocking execFileSync call.
      { env: { ...process.env, TZ: "Pacific/Honolulu" }, encoding: "utf8", timeout: 15000 },
    );
    expect(stdout).toBe("7/5/2026");
  });
});
