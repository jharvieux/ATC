// [review gap-fill for #719] Shared staleness threshold for stripe_webhook_events.
//
// A row that started processing this long ago but never wrote
// processing_completed_at is presumed CRASHED (stale), not in-flight. The webhook
// handler's stale-duplicate clear and the stripe-webhook-incomplete-reconcile cron
// MUST use the same value: if they disagreed, the handler could delete a row the
// cron still treats as live (or vice-versa), reopening the double-processing race
// this guard exists to close.
export const STALE_WEBHOOK_PROCESSING_MS = 5 * 60 * 1000;
