/**
 * BP31 §32.7.5 — GitHub issue creation resilience.
 *
 * Handles two failure shapes:
 *
 *   1. **Quarantine** (`PIIZeroToleranceQuarantineError` from
 *      `lib/github/issues.ts → createBugIssue`): NOT retried. Caller
 *      surface sets `github_issue_state='quarantined'`, fires admin alert
 *      with category `bug_report_pii_quarantine`, and shows the friendly
 *      "contact platform support directly" message. This handler is the
 *      single place that touches the row state on quarantine.
 *
 *   2. **Transient GitHub failure** (`GitHubAPIError`): retried with the
 *      §32.7.5 exponential backoff schedule. After 24 hours of failure
 *      the row goes to `'failed'`; the user banner appears; admin alert
 *      fires.
 *
 * Backoff schedule per §32.7.5: 1m / 5m / 30m / 2h / 8h / 24h. Inngest's
 * `step.sleepUntil` schedules each retry; the function self-terminates
 * after the 24h step's failure.
 *
 * Dispatched by `POST /api/help/bugs` (and the equivalent feature route)
 * via `help.bug_submitted` / `help.feature_submitted` events. The route
 * handlers themselves call `createBugIssue` once synchronously to catch
 * the quarantine path eagerly; only `GitHubAPIError` results in the
 * event being scheduled.
 */

import { inngest } from "./client";
import { tenantContextFromInngestEvent } from "@/lib/db/factories";
import { tenantClient } from "@/lib/db/tenant-client";
import {
  createBugIssue,
  createFeatureIssue,
  GitHubAPIError,
  PIIZeroToleranceQuarantineError,
  type BugSubmissionInput,
  type FeatureRequestInput,
} from "@/lib/github/issues";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { writeAuditLog } from "@/lib/audit/write";

const BACKOFF_DELAYS_MS = [
  60_000,         // 1m
  5 * 60_000,     // 5m
  30 * 60_000,    // 30m
  2 * 60 * 60_000,  // 2h
  8 * 60 * 60_000,  // 8h
  24 * 60 * 60_000, // 24h
] as const;

interface SubmissionRetryPayload {
  tenant_id: string;
  submission_id: string;            // bug_submissions.id or feature_requests.id
  submission_kind: "bug" | "feature";
  input: BugSubmissionInput | FeatureRequestInput;
  attempt: number;                  // 0-indexed; this attempt's index in BACKOFF_DELAYS_MS
}

async function setSubmissionState(
  ctx: Awaited<ReturnType<typeof tenantContextFromInngestEvent>>,
  kind: "bug" | "feature",
  submission_id: string,
  patch: {
    github_issue_number?: number;
    github_issue_url?: string;
    github_issue_state?: "open" | "failed" | "quarantined";
    github_creation_error?: string;
    quarantine_reason?: string;
  },
): Promise<void> {
  // §11.2.2 tenant-scoped surface: bug_submissions / feature_requests row is
  // owned by ctx.tenant_id; RLS lets the tenant client update it via id PK.
  const db = tenantClient(ctx);
  const table = kind === "bug" ? "bug_submissions" : "feature_requests";
  await db.from(table).update(patch).eq("id", submission_id);
}

export const githubIssueRetry = inngest.createFunction(
  {
    id: "github-issue-retry",
    triggers: [{ event: "help.github_issue_creation_failed" }],
  },
  async ({ event, step }) => {
    const data = event.data as SubmissionRetryPayload;
    const ctx = tenantContextFromInngestEvent(event);
    const attempt = data.attempt ?? 0;
    if (attempt >= BACKOFF_DELAYS_MS.length) {
      // Exhausted — final 'failed' state was already written before this
      // event was scheduled. Defensive log only.
      console.warn(
        `[github-issue-retry] received attempt ${attempt} >= ${BACKOFF_DELAYS_MS.length}; ignoring`,
      );
      return { ignored: true };
    }

    const delay = BACKOFF_DELAYS_MS[attempt]!;
    await step.sleep("retry-backoff", delay);

    try {
      const result =
        data.submission_kind === "bug"
          ? await createBugIssue(data.input as BugSubmissionInput)
          : await createFeatureIssue(data.input as FeatureRequestInput);

      await setSubmissionState(ctx, data.submission_kind, data.submission_id, {
        github_issue_number: result.issue_number,
        github_issue_url: result.issue_url,
        github_issue_state: "open",
      });
      await writeAuditLog({
        tenant_id: data.tenant_id,
        actor_type: "system",
        action: "github.issue_created",
        resource_type: data.submission_kind === "bug" ? "bug_submission" : "feature_request",
        resource_id: data.submission_id,
        changes: { issue_number: result.issue_number, retry_attempt: attempt + 1 },
      });
      return { ok: true, issue_number: result.issue_number, retry_attempt: attempt + 1 };
    } catch (err) {
      // Quarantine doesn't reach the retry path under normal flow (the
      // route handler quarantines synchronously). Belt-and-suspenders here.
      if (err instanceof PIIZeroToleranceQuarantineError) {
        await setSubmissionState(ctx, data.submission_kind, data.submission_id, {
          github_issue_state: "quarantined",
          quarantine_reason: `pii_zero_tolerance: ${[...new Set(err.hits.map((h) => h.kind))].join(",")}`,
        });
        await sendOperatorAlert({
          severity: "high",
          signal: "bug_report_pii_quarantine",
          detail: `Bug submission ${data.submission_id} contained zero-tolerance PII during a retry attempt.`,
          payload: { tenant_id: data.tenant_id, submission_id: data.submission_id },
        });
        return { quarantined: true };
      }

      if (err instanceof GitHubAPIError) {
        const isLastAttempt = attempt + 1 >= BACKOFF_DELAYS_MS.length;
        if (isLastAttempt) {
          await setSubmissionState(ctx, data.submission_kind, data.submission_id, {
            github_issue_state: "failed",
            github_creation_error: `${err.endpoint}: ${err.message}`,
          });
          await writeAuditLog({
            tenant_id: data.tenant_id,
            actor_type: "system",
            action: "github.issue_creation_failed",
            resource_type: data.submission_kind === "bug" ? "bug_submission" : "feature_request",
            resource_id: data.submission_id,
            changes: {
              endpoint: err.endpoint,
              status: err.status,
              total_attempts: attempt + 1,
              message: err.message,
            },
          });
          await sendOperatorAlert({
            severity: "high",
            signal: "github_issue_creation_failed_24h",
            detail: `GitHub issue creation failed after ${BACKOFF_DELAYS_MS.length} attempts over 24h for ${data.submission_kind} submission ${data.submission_id}.`,
            payload: {
              tenant_id: data.tenant_id,
              submission_id: data.submission_id,
              endpoint: err.endpoint,
              status: err.status,
            },
          });
          return { failed: true };
        }

        // Schedule the next attempt.
        await inngest.send({
          name: "help.github_issue_creation_failed",
          data: { ...data, attempt: attempt + 1 },
        });
        return { retrying: true, next_attempt: attempt + 1 };
      }

      // Unknown error shape — surface it and stop retrying.
      await sendOperatorAlert({
        severity: "high",
        signal: "github_issue_creation_unknown_error",
        detail: `Unknown error during GitHub issue creation retry: ${(err as Error).message}`,
        payload: { tenant_id: data.tenant_id, submission_id: data.submission_id },
      });
      throw err;
    }
  },
);
