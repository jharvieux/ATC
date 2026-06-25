// BP31 §32.6.3 — Submit a bug report + list current tenant's bug submissions.
//
// POST: §32.7.5/.6 — eager PII zero-tolerance quarantine path runs
// synchronously; on transient GitHub failure we enqueue the retry event
// and return 202. The bug_submissions row is always created first so
// the caller always gets an `id` back regardless of the GitHub outcome.
//
// GET: tenant-scoped list (RLS enforces; this surface returns the caller's
// tenant only — customer callers are served their own rows via the
// §32.5.5 customer-self policy and the redacted projection per §32.6.3).

import { assertPermission } from "@/lib/auth/assert-permission";
import { respondToAuthError } from "@/lib/auth/respond";
import { tenantClient } from "@/lib/db/tenant-client";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { writeAuditLog } from "@/lib/audit/write";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { inngest } from "@/inngest/client";
import { safeAwait } from "@/lib/db/safe-mutation";
import {
  createBugIssue,
  GitHubAPIError,
  PIIZeroToleranceQuarantineError,
  type BugSubmissionInput,
} from "@/lib/github/issues";
import {
  checkCustomerBugLimit,
  recordCustomerBugSubmission,
  getPoliteRefusalMessage,
} from "@/lib/help-ai/customer-rate-limit";
import {
  checkHelpSubmissionRate,
  incrementHelpSubmissionCounter,
} from "@/lib/abuse/help-submission-rate";

interface SubmitBugBody {
  help_session_id?: string;
  source_type?: "tenant_admin" | "tenant_agent" | "customer";
  where_in_platform?: string;
  actual_behavior?: string;
  expected_behavior?: string;
  steps_to_reproduce?: string;
  frequency?: "always" | "sometimes" | "once" | "unknown";
  browser_info?: { browser?: string; os?: string; viewport?: string } | null;
  screenshots?: string[];
  confidence_score?: number | null;
  confidence_factors?: Record<string, number> | null;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "bug_submission", action: "create" });
    const body = (await req.json().catch(() => ({}))) as SubmitBugBody;

    if (!body.help_session_id || !body.source_type) {
      return Response.json({ error: "missing_fields", message: "help_session_id and source_type are required" }, { status: 400 });
    }

    const db = tenantClient(ctx);

    // ── BP32 §32.11.4 — per-customer rate limit (customer source_type only)
    if (body.source_type === "customer") {
      const limit = await checkCustomerBugLimit(db, user.id, ctx.tenant_id);
      if (!limit.allowed) {
        return Response.json(
          { error: "rate_limited", message: getPoliteRefusalMessage(), count_today: limit.count_today, limit: limit.limit },
          { status: 429 },
        );
      }
    }

    // ── BP32 §32.11.2 — tenant-wide help_submission_rate gate. Returns
    //    soft2 throttle / hard block messages when exceeded.
    const rateCheck = await checkHelpSubmissionRate(db, ctx.tenant_id);
    if (!rateCheck.allowed) {
      const { message: rateMsg, state: rateState, count_today: rateCountToday } = rateCheck;
      return Response.json(
        { error: "rate_limited", message: rateMsg, state: rateState, count_today: rateCountToday },
        { status: 429 },
      );
    }

    // Tenant slug for the issue body (we hash tenant_id in the visible portion;
    // slug is platform-internal identifier still safe to show).
    const { data: tRow } = await db
      .from("tenants")
      .select("slug")
      .eq("id", ctx.tenant_id)
      .maybeSingle();
    const tenant_slug = (tRow as { slug?: string } | null)?.slug ?? "unknown";

    // 1. Insert the bug_submissions row first so we always return an id.
    const insertPayload = {
      help_session_id: body.help_session_id,
      tenant_id: ctx.tenant_id,
      submitter_user_id: user.id,
      source_type: body.source_type,
      where_in_platform: body.where_in_platform ?? null,
      actual_behavior: body.actual_behavior ?? null,
      expected_behavior: body.expected_behavior ?? null,
      steps_to_reproduce: body.steps_to_reproduce ?? null,
      frequency: body.frequency ?? null,
      browser_info: body.browser_info ?? null,
      screenshots: body.screenshots ?? [],
      confidence_score: body.confidence_score ?? null,
      confidence_factors: body.confidence_factors ?? null,
      github_issue_state: "pending",
    };
    const { data: inserted, error: insertErr } = await db
      .from("bug_submissions")
      .insert(insertPayload)
      .select("id")
      .single();
    if (insertErr || !inserted) {
      return dbErrorResponse(insertErr);
    }
    const submission_id = (inserted as { id: string }).id;

    // 2. Build the input for the GitHub issue creator.
    const githubInput: BugSubmissionInput = {
      tenant_id: ctx.tenant_id,
      tenant_slug,
      source_type: body.source_type,
      submitter_role: "tenant_admin",
      confidence_score: body.confidence_score ?? null,
      where_in_platform: body.where_in_platform ?? null,
      actual_behavior: body.actual_behavior ?? null,
      expected_behavior: body.expected_behavior ?? null,
      steps_to_reproduce: body.steps_to_reproduce ?? null,
      frequency: body.frequency ?? null,
      browser_info: body.browser_info ?? null,
      screenshot_urls: body.screenshots ?? [],
      help_session_id: body.help_session_id,
      submitted_at: new Date().toISOString(),
    };

    // 3. Attempt creation synchronously (§32.7.5 eager path).
    try {
      const result = await createBugIssue(githubInput);
      await safeAwait(db
        .from("bug_submissions")
        .update({
          github_issue_number: result.issue_number,
          github_issue_url: result.issue_url,
          github_issue_state: "open",
        })
        .eq("id", submission_id), "bug_submissions.update");
      await writeAuditLog({
        tenant_id: ctx.tenant_id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "github.issue_created",
        resource_type: "bug_submission",
        resource_id: submission_id,
        changes: { issue_number: result.issue_number },
      });
      await inngest.send({
        name: "help.bug_submitted",
        data: { tenant_id: ctx.tenant_id, submission_id, issue_number: result.issue_number },
      });
      // BP32 §32.11 — increment counters on SUCCESSFUL submission (not on quarantine).
      await incrementHelpSubmissionCounter(db, ctx.tenant_id);
      if (body.source_type === "customer") {
        await recordCustomerBugSubmission(db, user.id, ctx.tenant_id);
      }
      return Response.json({ id: submission_id, github_issue_state: "open", issue_url: result.issue_url }, { status: 201 });
    } catch (err) {
      if (err instanceof PIIZeroToleranceQuarantineError) {
        // §32.7.6 — quarantine path: do NOT create the issue, do NOT retry.
        const reason = `pii_zero_tolerance: ${[...new Set(err.hits.map((h) => h.kind))].join(",")}`;
        await safeAwait(db
          .from("bug_submissions")
          .update({ github_issue_state: "quarantined", quarantine_reason: reason })
          .eq("id", submission_id), "bug_submissions.update");
        await writeAuditLog({
          tenant_id: ctx.tenant_id,
          actor_user_id: user.id,
          actor_type: "user",
          action: "help.pii_zero_tolerance_quarantine",
          resource_type: "bug_submission",
          resource_id: submission_id,
          changes: { kinds: [...new Set(err.hits.map((h) => h.kind))] },
        });
        await sendOperatorAlert({
          severity: "high",
          signal: "bug_report_pii_quarantine",
          detail: `Bug submission ${submission_id} contained zero-tolerance PII; quarantined.`,
          payload: { tenant_id: ctx.tenant_id, submission_id },
        });
        return Response.json(
          {
            id: submission_id,
            github_issue_state: "quarantined",
            message: "Your report contains information we can't process safely. Please contact platform support directly.",
          },
          { status: 202 },
        );
      }
      if (err instanceof GitHubAPIError) {
        // §32.7.5 — schedule the retry. Row stays 'pending'.
        await inngest.send({
          name: "help.github_issue_creation_failed",
          data: {
            tenant_id: ctx.tenant_id,
            submission_id,
            submission_kind: "bug",
            input: githubInput,
            attempt: 0,
          },
        });
        // BP32 §32.11 — "increment on successful submission, not on attempt"
        // means: row was accepted (we own a bug_submissions id). GitHub
        // transient failure with retry queued still counts. Only the
        // PII quarantine path (above) skips the counter.
        await incrementHelpSubmissionCounter(db, ctx.tenant_id);
        if (body.source_type === "customer") {
          await recordCustomerBugSubmission(db, user.id, ctx.tenant_id);
        }
        return Response.json(
          { id: submission_id, github_issue_state: "pending", message: "Your report was received; we'll file it on GitHub shortly." },
          { status: 202 },
        );
      }
      throw err;
    }
  } catch (err) {
    return respondToAuthError(err);
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "bug_submission", action: "read" });
    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("bug_submissions")
      .select(
        "id, source_type, where_in_platform, actual_behavior, expected_behavior, frequency, confidence_score, github_issue_number, github_issue_url, github_issue_state, triage_state, submitted_at, closed_at",
      )
      .order("submitted_at", { ascending: false })
      .limit(100);
    if (error) return dbErrorResponse(error);
    return Response.json({ items: data ?? [] });
  } catch (err) {
    return respondToAuthError(err);
  }
}
