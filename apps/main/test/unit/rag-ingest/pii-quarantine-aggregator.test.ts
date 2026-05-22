// §22.4a — PII quarantine alert aggregation tests.
//
// Why these matter: this state machine decides whether an operator gets a
// new alert (interruption) vs a quiet count update (no noise) vs the
// 3-consecutive-day abuse escalation. Wrong thresholds either burn out the
// alerting channel or hide an active leak.

import { describe, it, expect } from "vitest";
import {
  computeAggregation,
  type AggregationState,
} from "@/lib/rag-ingest/pii-quarantine-aggregator";

const EMPTY: AggregationState = {
  pii_quarantine_alert_window_start: null,
  pii_quarantine_alert_count_in_window: 0,
  pii_quarantine_recurring_days: 0,
  pii_quarantine_last_event_at: null,
};

describe("computeAggregation — §22.4a", () => {
  it("first event opens a fresh window and SENDs a new alert", () => {
    const now = new Date("2026-05-22T12:00:00Z");
    const d = computeAggregation({
      current: EMPTY,
      now,
      window_hours: 24,
      recurring_pattern_days: 3,
    });
    expect(d.alert_action).toBe("send_new");
    expect(d.next.pii_quarantine_alert_count_in_window).toBe(1);
    expect(d.next.pii_quarantine_recurring_days).toBe(1);
    expect(d.emit_recurring_pattern_event).toBe(false);
  });

  it("second event within 24h UPDATEs the existing alert (no new send)", () => {
    const ws = new Date("2026-05-22T12:00:00Z");
    const cur: AggregationState = {
      pii_quarantine_alert_window_start: ws,
      pii_quarantine_alert_count_in_window: 1,
      pii_quarantine_recurring_days: 1,
      pii_quarantine_last_event_at: ws,
    };
    const d = computeAggregation({
      current: cur,
      now: new Date("2026-05-22T20:00:00Z"), // 8h later
      window_hours: 24,
      recurring_pattern_days: 3,
    });
    expect(d.alert_action).toBe("update_existing");
    expect(d.next.pii_quarantine_alert_count_in_window).toBe(2);
  });

  it("event after window expiry opens a NEW window (send_new)", () => {
    const ws = new Date("2026-05-22T12:00:00Z");
    const cur: AggregationState = {
      pii_quarantine_alert_window_start: ws,
      pii_quarantine_alert_count_in_window: 4,
      pii_quarantine_recurring_days: 1,
      pii_quarantine_last_event_at: new Date("2026-05-22T23:00:00Z"),
    };
    const now = new Date("2026-05-23T13:00:00Z"); // 25h after window_start
    const d = computeAggregation({
      current: cur,
      now,
      window_hours: 24,
      recurring_pattern_days: 3,
    });
    expect(d.alert_action).toBe("send_new");
    expect(d.next.pii_quarantine_alert_count_in_window).toBe(1);
    // Daily-ish gap → streak extends to 2.
    expect(d.next.pii_quarantine_recurring_days).toBe(2);
  });

  it("third consecutive day emits the recurring-pattern event", () => {
    // Streak already at 2; a third day's event hits the threshold.
    const cur: AggregationState = {
      pii_quarantine_alert_window_start: new Date("2026-05-22T12:00:00Z"),
      pii_quarantine_alert_count_in_window: 1,
      pii_quarantine_recurring_days: 2,
      pii_quarantine_last_event_at: new Date("2026-05-22T23:00:00Z"),
    };
    const d = computeAggregation({
      current: cur,
      now: new Date("2026-05-23T13:00:00Z"),
      window_hours: 24,
      recurring_pattern_days: 3,
    });
    expect(d.next.pii_quarantine_recurring_days).toBe(3);
    expect(d.emit_recurring_pattern_event).toBe(true);
  });

  it("long gap resets the consecutive-day streak", () => {
    const cur: AggregationState = {
      pii_quarantine_alert_window_start: new Date("2026-05-22T12:00:00Z"),
      pii_quarantine_alert_count_in_window: 5,
      pii_quarantine_recurring_days: 7, // hot streak
      pii_quarantine_last_event_at: new Date("2026-05-22T23:00:00Z"),
    };
    const d = computeAggregation({
      current: cur,
      now: new Date("2026-06-10T13:00:00Z"), // ~3 weeks later
      window_hours: 24,
      recurring_pattern_days: 3,
    });
    expect(d.alert_action).toBe("send_new");
    expect(d.next.pii_quarantine_recurring_days).toBe(1);
    expect(d.emit_recurring_pattern_event).toBe(false);
  });
});
