// BP31 §32.6.4 — Submit a feature request + list current tenant's feature requests.
//
// Same shape as /api/help/bugs/route.ts but no triage_state, lighter body
// per §32.4.3.

import { assertPermission } from "@/lib/auth/assert-permission";
import { tenantClient } from "@/lib/db/tenant-client";
import { writeAuditLog } from "@/lib/audit/write";
import { sendOperatorAlert } from "@/lib/monitoring/send-operator-alert";
import { inngest } from "@/inngest/client";
import { safeAwait } from "@/lib/db/safe-mutation";
import {
  createFeatureIssue,
  GitHubAPIError,
  PIIZeroToleranceQuarantineError,
  type FeatureRequestInput,
} from "@/lib/github/issues";
import {
  checkHelpSubmissionRate,
  incrementHelpSubmissionCounter,
} from "@/lib/abuse/help-submission-rate";

interface SubmitFeatureBody {
  help_session_id?: string;
  source_type?: "tenant_admin" | "tenant_agent" | "customer";
  what?: string;
  why?: string;
  current_workaround?: string;
  expected_usage_frequency?: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "feature_request", action: "create" });
    const body = (await req.json().catch(() => ({}))) as SubmitFeatureBody;
    if (!body.help_session_id || !body.source_type) {
      return Response.json({ error: "missing_fields" }, { status: 400 });
    }

    const db = tenantClient(ctx);

    // BP32 §32.11.2 — tenant-wide help_submission_rate gate. Same shape as
    // POST /api/help/bugs so a tenant pinned at hard or throttled at
    // soft2 can't bypass via the feature endpoint.
    const rateCheck = await checkHelpSubmissionRate(db, ctx.tenant_id);
    if (!rateCheck.allowed) {
      return Response.json(
        { error: "rate_limited", message: rateCheck.message, state: rateCheck.state, count_today: rateCheck.count_today },
        { status: 429 },
      );
    }

    const { data: tRow } = await db.from("tenants").select("slug").eq("id", ctx.tenant_id).maybeSingle();
    const tenant_slug = (tRow as { slug?: string } | null)?.slug ?? "unknown";

    const { data: inserted, error: insertErr } = await db
      .from("feature_requests")
      .insert({
        help_session_id: body.help_session_id,
        tenant_id: ctx.tenant_id,
        submitter_user_id: user.id,
        source_type: body.source_type,
        what: body.what ?? null,
        why: body.why ?? null,
        current_workaround: body.current_workaround ?? null,
        expected_usage_frequency: body.expected_usage_frequency ?? null,
        github_issue_state: "pending",
      })
      .select("id")
      .single();
    if (insertErr || !inserted) {
      return Response.json({ error: "db_error", message: insertErr?.message ?? "unknown" }, { status: 500 });
    }
    const submission_id = (inserted as { id: string }).id;

    const githubInput: FeatureRequestInput = {
      tenant_id: ctx.tenant_id,
      tenant_slug,
      source_type: body.source_type,
      what: body.what ?? null,
      why: body.why ?? null,
      current_workaround: body.current_workaround ?? null,
      expected_usage_frequency: body.expected_usage_frequency ?? null,
      help_session_id: body.help_session_id,
      submitted_at: new Date().toISOString(),
    };

    try {
      const result = await createFeatureIssue(githubInput);
      await safeAwait(db
        .from("feature_requests")
        .update({
          github_issue_number: result.issue_number,
          github_issue_url: result.issue_url,
          github_issue_state: "open",
        })
        .eq("id", submission_id), "feature_requests.update");
      await writeAuditLog({
        tenant_id: ctx.tenant_id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "github.issue_created",
        resource_type: "feature_request",
        resource_id: submission_id,
        changes: { issue_number: result.issue_number },
      });
      await inngest.send({
        name: "help.feature_submitted",
        data: { tenant_id: ctx.tenant_id, submission_id, issue_number: result.issue_number },
      });
      // BP32 §32.11 — increment help_submission_rate on successful submission.
      await incrementHelpSubmissionCounter(db, ctx.tenant_id);
      return Response.json({ id: submission_id, github_issue_state: "open", issue_url: result.issue_url }, { status: 201 });
    } catch (err) {
      if (err instanceof PIIZeroToleranceQuarantineError) {
        await safeAwait(db
          .from("feature_requests")
          .update({ github_issue_state: "quarantined" })
          .eq("id", submission_id), "feature_requests.update");
        await writeAuditLog({
          tenant_id: ctx.tenant_id,
          actor_user_id: user.id,
          actor_type: "user",
          action: "help.pii_zero_tolerance_quarantine",
          resource_type: "feature_request",
          resource_id: submission_id,
          changes: { kinds: [...new Set(err.hits.map((h) => h.kind))] },
        });
        await sendOperatorAlert({
          severity: "high",
          signal: "feature_request_pii_quarantine",
          detail: `Feature request ${submission_id} contained zero-tolerance PII; quarantined.`,
          payload: { tenant_id: ctx.tenant_id, submission_id },
        });
        return Response.json(
          { id: submission_id, github_issue_state: "quarantined", message: "Your request contains information we can't process safely. Please contact platform support directly." },
          { status: 202 },
        );
      }
      if (err instanceof GitHubAPIError) {
        await inngest.send({
          name: "help.github_issue_creation_failed",
          data: {
            tenant_id: ctx.tenant_id,
            submission_id,
            submission_kind: "feature",
            input: githubInput,
            attempt: 0,
          },
        });
        // BP32 §32.11 — row accepted; counter increments per spec.
        await incrementHelpSubmissionCounter(db, ctx.tenant_id);
        return Response.json({ id: submission_id, github_issue_state: "pending" }, { status: 202 });
      }
      throw err;
    }
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { ctx } = await assertPermission(req, { resource: "feature_request", action: "read" });
    const db = tenantClient(ctx);
    const { data, error } = await db
      .from("feature_requests")
      .select("id, source_type, what, why, github_issue_number, github_issue_url, github_issue_state, decision, submitted_at, decided_at")
      .order("submitted_at", { ascending: false })
      .limit(100);
    if (error) return Response.json({ error: "db_error", message: error.message }, { status: 500 });
    return Response.json({ items: data ?? [] });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "unauthorized" }, { status: 401 });
  }
}
