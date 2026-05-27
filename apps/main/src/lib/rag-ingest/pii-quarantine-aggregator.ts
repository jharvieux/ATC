// §22.4a — PII quarantine alert aggregation.
//
// The behavior contract (from spec):
//   1. First quarantine event for a tenant → SEND an immediate alert.
//   2. Subsequent quarantines within RAG_INGEST_AGGREGATION_WINDOW_HOURS
//      (default 24h) → INCREMENT the running count and UPDATE the existing
//      alert in place. Do NOT send a new alert.
//   3. After the window expires (next event > 24h after window_start):
//      open a NEW window, send a NEW alert.
//   4. Consecutive-day pattern: when window_start advances by ~1 day from
//      the previous window's end (suggesting daily activity), increment
//      pii_quarantine_recurring_days. When that counter hits
//      RAG_INGEST_RECURRING_PATTERN_DAYS (default 3), emit
//      Inngest event 'tenant.rag_pii_recurring_pattern_detected' for the
//      BP27 abuse-signal subsystem (no consumer yet — §27 ships separately).
//
// All state lives in the tenants table columns:
//   pii_quarantine_alert_window_start,
//   pii_quarantine_alert_count_in_window,
//   pii_quarantine_recurring_days,
//   pii_quarantine_last_event_at.
//
// Designed as a pure function over the current tenant state so it can be
// unit-tested without DB or Inngest mocks. The caller (Stage 2 Inngest
// function) reads the tenant row, calls computeAggregation, writes the
// resulting state back, and emits the alerts/events the result names.

export interface AggregationState {
  pii_quarantine_alert_window_start: Date | null;
  pii_quarantine_alert_count_in_window: number;
  pii_quarantine_recurring_days: number;
  pii_quarantine_last_event_at: Date | null;
}

export interface AggregationDecision {
  next: AggregationState;
  alert_action: "send_new" | "update_existing" | "none";
  emit_recurring_pattern_event: boolean;
}

export function computeAggregation(opts: {
  current: AggregationState;
  now: Date;
  window_hours: number;
  recurring_pattern_days: number;
}): AggregationDecision {
  const { current, now, window_hours, recurring_pattern_days } = opts;
  const windowMs = window_hours * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;

  const ws = current.pii_quarantine_alert_window_start;
  const insideWindow = ws !== null && now.getTime() - ws.getTime() <= windowMs;

  if (!insideWindow) {
    // Open a new window. Determine consecutive-day pattern: if the prior
    // window's last event was within the prior 24–48 hour band relative to
    // 'now', count it as a consecutive day.
    const priorEnd = current.pii_quarantine_last_event_at;
    let recurringDays = current.pii_quarantine_recurring_days;
    if (priorEnd) {
      const gap = now.getTime() - priorEnd.getTime();
      if (gap <= 2 * dayMs) {
        // Daily-ish gap → extend the streak.
        recurringDays = recurringDays + 1;
      } else {
        // Gap too big → reset the streak.
        recurringDays = 1;
      }
    } else {
      recurringDays = 1;
    }

    const emitRecurring = recurringDays >= recurring_pattern_days;

    return {
      next: {
        pii_quarantine_alert_window_start: now,
        pii_quarantine_alert_count_in_window: 1,
        pii_quarantine_recurring_days: recurringDays,
        pii_quarantine_last_event_at: now,
      },
      alert_action: "send_new",
      emit_recurring_pattern_event: emitRecurring,
    };
  }

  // Inside the existing window — just increment the count and update the
  // existing alert in place.
  return {
    next: {
      pii_quarantine_alert_window_start: ws,
      pii_quarantine_alert_count_in_window: current.pii_quarantine_alert_count_in_window + 1,
      pii_quarantine_recurring_days: current.pii_quarantine_recurring_days,
      pii_quarantine_last_event_at: now,
    },
    alert_action: "update_existing",
    emit_recurring_pattern_event: false,
  };
}
