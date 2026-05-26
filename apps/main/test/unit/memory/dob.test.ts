// §11.5 — DOB lifecycle helper tests (post-D-087 cadence change).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isEstimatedDOBOverdue,
  isBookingImminent,
  repromptIntervalMs,
  imminentBookingWindowMs,
  type FamilyMember,
} from "../../../src/lib/memory/dob";

const ORIG_ENV = {
  DOB_REPROMPT_INTERVAL_DAYS: process.env.DOB_REPROMPT_INTERVAL_DAYS,
  DOB_IMMINENT_BOOKING_WINDOW_DAYS: process.env.DOB_IMMINENT_BOOKING_WINDOW_DAYS,
};

beforeEach(() => {
  delete process.env.DOB_REPROMPT_INTERVAL_DAYS;
  delete process.env.DOB_IMMINENT_BOOKING_WINDOW_DAYS;
});

afterEach(() => {
  process.env.DOB_REPROMPT_INTERVAL_DAYS = ORIG_ENV.DOB_REPROMPT_INTERVAL_DAYS;
  process.env.DOB_IMMINENT_BOOKING_WINDOW_DAYS = ORIG_ENV.DOB_IMMINENT_BOOKING_WINDOW_DAYS;
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("repromptIntervalMs", () => {
  it("defaults to 30 days", () => {
    expect(repromptIntervalMs()).toBe(30 * DAY_MS);
  });

  it("respects env override", () => {
    process.env.DOB_REPROMPT_INTERVAL_DAYS = "7";
    expect(repromptIntervalMs()).toBe(7 * DAY_MS);
  });

  it("falls back to 30 on invalid input", () => {
    process.env.DOB_REPROMPT_INTERVAL_DAYS = "not-a-number";
    expect(repromptIntervalMs()).toBe(30 * DAY_MS);
    process.env.DOB_REPROMPT_INTERVAL_DAYS = "0";
    expect(repromptIntervalMs()).toBe(30 * DAY_MS);
    process.env.DOB_REPROMPT_INTERVAL_DAYS = "-5";
    expect(repromptIntervalMs()).toBe(30 * DAY_MS);
  });
});

describe("imminentBookingWindowMs", () => {
  it("defaults to 60 days", () => {
    expect(imminentBookingWindowMs()).toBe(60 * DAY_MS);
  });

  it("respects env override", () => {
    process.env.DOB_IMMINENT_BOOKING_WINDOW_DAYS = "45";
    expect(imminentBookingWindowMs()).toBe(45 * DAY_MS);
  });
});

describe("isEstimatedDOBOverdue", () => {
  it("returns false for non-estimated DOBs", () => {
    const entry: FamilyMember = {
      date_of_birth: "1985-03-15",
      date_of_birth_is_estimated: false,
      estimation_recorded_at: new Date(Date.now() - 100 * DAY_MS).toISOString(),
    };
    expect(isEstimatedDOBOverdue(entry)).toBe(false);
  });

  it("returns false when estimation_recorded_at is missing", () => {
    const entry: FamilyMember = {
      date_of_birth_is_estimated: true,
    };
    expect(isEstimatedDOBOverdue(entry)).toBe(false);
  });

  it("returns true when estimated > 30 days ago and never re-prompted", () => {
    const entry: FamilyMember = {
      date_of_birth_is_estimated: true,
      estimation_recorded_at: new Date(Date.now() - 31 * DAY_MS).toISOString(),
    };
    expect(isEstimatedDOBOverdue(entry)).toBe(true);
  });

  it("returns false when estimated < 30 days ago", () => {
    const entry: FamilyMember = {
      date_of_birth_is_estimated: true,
      estimation_recorded_at: new Date(Date.now() - 5 * DAY_MS).toISOString(),
    };
    expect(isEstimatedDOBOverdue(entry)).toBe(false);
  });

  it("respects custom DOB_REPROMPT_INTERVAL_DAYS", () => {
    process.env.DOB_REPROMPT_INTERVAL_DAYS = "7";
    const entry: FamilyMember = {
      date_of_birth_is_estimated: true,
      estimation_recorded_at: new Date(Date.now() - 8 * DAY_MS).toISOString(),
    };
    expect(isEstimatedDOBOverdue(entry)).toBe(true); // overdue at 8d with 7d window
    process.env.DOB_REPROMPT_INTERVAL_DAYS = "30";
    expect(isEstimatedDOBOverdue(entry)).toBe(false); // not overdue at 8d with 30d window
  });

  it("returns false when last_reprompt_at is recent (within the interval)", () => {
    const entry: FamilyMember = {
      date_of_birth_is_estimated: true,
      estimation_recorded_at: new Date(Date.now() - 200 * DAY_MS).toISOString(),
      estimation_last_reprompt_at: new Date(Date.now() - 5 * DAY_MS).toISOString(),
    };
    expect(isEstimatedDOBOverdue(entry)).toBe(false);
  });

  it("returns true when last_reprompt_at is older than the interval", () => {
    const entry: FamilyMember = {
      date_of_birth_is_estimated: true,
      estimation_recorded_at: new Date(Date.now() - 200 * DAY_MS).toISOString(),
      estimation_last_reprompt_at: new Date(Date.now() - 31 * DAY_MS).toISOString(),
    };
    expect(isEstimatedDOBOverdue(entry)).toBe(true);
  });

  it("guards against unparseable timestamps", () => {
    const entry: FamilyMember = {
      date_of_birth_is_estimated: true,
      estimation_recorded_at: "not-a-date",
    };
    expect(isEstimatedDOBOverdue(entry)).toBe(false);
  });
});

describe("isBookingImminent", () => {
  it("returns true when sailing_date is within 60 days from now", () => {
    const inThirtyDays = new Date(Date.now() + 30 * DAY_MS).toISOString();
    expect(isBookingImminent(inThirtyDays)).toBe(true);
  });

  it("returns false when sailing_date is past", () => {
    const inPast = new Date(Date.now() - 10 * DAY_MS).toISOString();
    expect(isBookingImminent(inPast)).toBe(false);
  });

  it("returns false when sailing_date is beyond the window", () => {
    const farFuture = new Date(Date.now() + 120 * DAY_MS).toISOString();
    expect(isBookingImminent(farFuture)).toBe(false);
  });

  it("treats the window boundary as imminent (inclusive)", () => {
    const atBoundary = new Date(Date.now() + 60 * DAY_MS - 1000).toISOString();
    expect(isBookingImminent(atBoundary)).toBe(true);
  });

  it("respects custom DOB_IMMINENT_BOOKING_WINDOW_DAYS", () => {
    process.env.DOB_IMMINENT_BOOKING_WINDOW_DAYS = "14";
    const inThirtyDays = new Date(Date.now() + 30 * DAY_MS).toISOString();
    expect(isBookingImminent(inThirtyDays)).toBe(false);
    const inSevenDays = new Date(Date.now() + 7 * DAY_MS).toISOString();
    expect(isBookingImminent(inSevenDays)).toBe(true);
  });

  it("returns false for unparseable sailing_date", () => {
    expect(isBookingImminent("not-a-date")).toBe(false);
  });
});
