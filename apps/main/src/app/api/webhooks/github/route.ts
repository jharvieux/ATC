/**
 * BP32 §32.10.7 — GitHub webhook handler for issues.closed.
 *
 * GitHub Apps sign every webhook with HMAC-SHA256 using the App's
 * webhook secret. We verify the signature, parse the event, and on
 * `issues.closed` we update the corresponding `bug_submissions` row.
 *
 * Per §32.10.7: customers are NOT notified on closure (issue-lifecycle
 * notifications are out of scope per §32.1.2). The §32.6.3 status route
 * reflects the closed state for tenant admins and platform staff; the
 * customer is not alerted.
 *
 * Auth: the signature is the authority — there's no JWT or platform
 * auth on this route. The signature check fails-closed on missing
 * secret + missing header.
 */

import { withPlatformAdminAudit } from "@/lib/db/platform-admin-client";
import { env } from "@/lib/env";
import { inngest } from "@/inngest/client";
import { verifyGitHubSignature } from "@/lib/webhooks/github-signature";

interface GitHubIssuePayload {
  action: string;
  issue?: { number: number; state?: string; state_reason?: string };
  comment?: { body?: string };
}

export async function POST(req: Request): Promise<Response> {
  const secret = env().GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    // Webhook is not configured. Fail-closed.
    return Response.json({ error: "webhook_not_configured" }, { status: 401 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  if (!verifyGitHubSignature(rawBody, signature, secret)) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  let payload: GitHubIssuePayload;
  try {
    payload = JSON.parse(rawBody) as GitHubIssuePayload;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  // We care about issues.closed only. Other events are 200 no-op so
  // GitHub doesn't keep retrying.
  if (payload.action !== "closed" || !payload.issue?.number) {
    return Response.json({ ok: true, ignored: true });
  }

  const issueNumber = payload.issue.number;
  const resolutionSummary = (payload.comment?.body ?? "").slice(0, 2000) || null;

  // Cross-tenant lookup wrapped in withPlatformAdminAudit per §5.4.4 —
  // the webhook has no tenant context until we resolve from the issue
  // number. The wrapper writes an audit_log row for the lookup so a
  // spoofed-signature-with-real-issue-id event is forensically visible.
  const result = await withPlatformAdminAudit(
    {
      admin_user_id: "system-github-webhook",
      reason: "bug_submission_review",
      operation: `github_webhook_issue_closed:${issueNumber}`,
    },
    async (db, recordQuery) => {
      const { data: submission } = await db
        .from("bug_submissions")
        .select("id, tenant_id, github_issue_state")
        .eq("github_issue_number", issueNumber)
        .maybeSingle();
      recordQuery({ op: "select", table: "bug_submissions", row_count: submission ? 1 : 0 });

      if (!submission) {
        return { ok: true, no_matching_submission: true } as const;
      }
      const row = submission as { id: string; tenant_id: string; github_issue_state: string };
      if (row.github_issue_state === "closed") {
        return { ok: true, already_closed: true, submission_id: row.id } as const;
      }

      const now = new Date().toISOString();
      const { error: updateErr } = await db
        .from("bug_submissions")
        .update({
          github_issue_state: "closed",
          closed_at: now,
          resolution_summary: resolutionSummary,
        })
        .eq("id", row.id);
      if (updateErr) throw new Error(updateErr.message);
      recordQuery({ op: "update", table: "bug_submissions", row_count: 1 });

      return { ok: true, submission_id: row.id, tenant_id: row.tenant_id } as const;
    },
  );

  // Emit help.issue_closed for any downstream subscribers (Phase 2+).
  if ("tenant_id" in result && result.tenant_id) {
    await inngest.send({
      name: "help.issue_closed",
      data: { tenant_id: result.tenant_id, submission_id: result.submission_id, issue_number: issueNumber },
    });
  }

  return Response.json(result);
}
