/**
 * BP31 §32.7 — GitHub issue creation with PII redaction.
 *
 * Single entry point for filing bug + feature issues to the platform repo
 * via the GitHub App. Wraps:
 *   1. §32.7.6 PII redaction — zero-tolerance quarantine THEN tolerable
 *      redaction (the tolerable pass is regex-only in Phase A; the
 *      Haiku pass is deferred per MEMORY D-065).
 *   2. §32.7.4 self-contained issue body — verbatim description, browser/OS,
 *      reproduction steps, screenshots inline. Tenant ID is hashed in the
 *      visible body (`tenant_id_hash = sha256(tenant_id + PLATFORM_PEPPER).slice(0,12)`);
 *      plaintext tenant_id never leaves the platform's bug_submissions row.
 *   3. §32.7.3 labels — `bug` or `feature-request`; `tenant-admin-reported`
 *      or `customer-reported`. Triage labels (`confirmed`/`unconfirmed`/
 *      `needs-human-fix`) are applied later during interactive triage (§32.9).
 *   4. §32.7.5 resilience — caller (the Inngest retry function) catches
 *      `GitHubAPIError` and retries with exponential backoff.
 *
 * Two callers: `POST /api/help/bugs` (creates the bug_submissions row,
 * then enqueues an Inngest event that invokes this module) and the
 * `github-issue-retry` Inngest function on failed submissions.
 *
 * Octokit imports are restricted to this file + `auth.ts` by the BP31
 * `atc/no-direct-octokit-import` lint rule.
 */

import { Octokit } from "@octokit/rest";
import { createHash } from "node:crypto";
import { getInstallationToken } from "./auth";
import { env } from "@/lib/env";
import {
  BUG_FIELDS,
  PIIZeroToleranceQuarantineError,
  assertNoZeroTolerancePii,
  redactSubmission,
} from "@/lib/help-ai/pii-redaction";

// Re-export the quarantine error so callers can `instanceof` it without
// importing from two paths.
export { PIIZeroToleranceQuarantineError } from "@/lib/help-ai/pii-redaction";

/**
 * Thrown on any GitHub API failure (network, 4xx, 5xx). The caller's
 * retry harness inspects `.status` to decide whether to back off or
 * surface the failure immediately.
 */
export class GitHubAPIError extends Error {
  readonly status: number | undefined;
  readonly endpoint: string;
  constructor(message: string, endpoint: string, status?: number) {
    super(message);
    this.name = "GitHubAPIError";
    this.endpoint = endpoint;
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export type SourceType = "tenant_admin" | "tenant_agent" | "customer";

export interface BugSubmissionInput {
  tenant_id: string;
  tenant_slug: string;
  source_type: SourceType;
  submitter_role: string;
  confidence_score: number | null;
  where_in_platform: string | null;
  actual_behavior: string | null;
  expected_behavior: string | null;
  steps_to_reproduce: string | null;
  frequency: string | null;
  browser_info: { browser?: string; os?: string; viewport?: string } | null;
  screenshot_urls: string[];
  help_session_id: string;
  submitted_at: string;
}

export interface FeatureRequestInput {
  tenant_id: string;
  tenant_slug: string;
  source_type: SourceType;
  what: string | null;
  why: string | null;
  current_workaround: string | null;
  expected_usage_frequency: string | null;
  help_session_id: string;
  submitted_at: string;
}

export interface CreatedIssue {
  issue_number: number;
  issue_url: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * §32.13.4 — `tenant_id_hash = sha256(tenant_id + PLATFORM_PEPPER).slice(0,12)`.
 *
 * Reuses the BP25 PLATFORM_PEPPER (which never rotates per D-058). Hash is
 * deterministic across runs — the same tenant always produces the same
 * 12-char prefix in every issue body.
 */
export function hashTenantId(tenant_id: string): string {
  const pepper = env().PLATFORM_PEPPER;
  return createHash("sha256").update(tenant_id + pepper).digest("hex").slice(0, 12);
}

function sourceTypeLabel(source: SourceType): "tenant-admin-reported" | "customer-reported" {
  return source === "customer" ? "customer-reported" : "tenant-admin-reported";
}

function escapeForMarkdown(s: string | null | undefined): string {
  if (!s) return "_(not provided)_";
  // Only neutralize the obvious — fences and triple-backticks — to keep the
  // user's wording readable. We deliberately don't HTML-escape: GitHub renders
  // user-supplied issue bodies as markdown; injection of HTML is treated as
  // markdown.
  return s.replace(/```/g, "ʼʼʼ");
}

function buildBugIssueBody(input: BugSubmissionInput, redacted: BugSubmissionInput): string {
  const tenant_id_hash = hashTenantId(input.tenant_id);
  const browser = input.browser_info?.browser ?? "unknown";
  const os = input.browser_info?.os ?? "unknown";
  const viewport = input.browser_info?.viewport ?? "unknown";
  const screenshotsBlock = input.screenshot_urls.length > 0
    ? input.screenshot_urls.map((u) => `![screenshot](${u})`).join("\n")
    : "_(no screenshots attached)_";
  return [
    "### Source",
    `- Type: ${sourceTypeLabel(input.source_type)}`,
    `- Tenant: ${input.tenant_slug} (id hash: ${tenant_id_hash})`,
    `- Submitter user role: ${input.submitter_role}`,
    `- Confidence/clarity score: ${input.confidence_score != null ? input.confidence_score.toFixed(2) : "n/a"}`,
    "",
    "### Where in the platform",
    escapeForMarkdown(redacted.where_in_platform),
    "",
    "### Actual behavior",
    escapeForMarkdown(redacted.actual_behavior),
    "",
    "### Expected behavior",
    escapeForMarkdown(redacted.expected_behavior),
    "",
    "### Steps to reproduce",
    escapeForMarkdown(redacted.steps_to_reproduce),
    "",
    "### Frequency",
    redacted.frequency ?? "_(not provided)_",
    "",
    "### Environment",
    `- Browser: ${browser}`,
    `- OS: ${os}`,
    `- Viewport: ${viewport}`,
    "",
    "### Screenshots",
    screenshotsBlock,
    "",
    "**Help session reference** (platform staff only, requires auth):",
    "",
    `/admin/help/sessions/${input.help_session_id}`,
    "",
    `*Auto-generated by Self-Service Help v1. Submitted at ${input.submitted_at}.*`,
  ].join("\n");
}

function buildFeatureIssueBody(input: FeatureRequestInput, redacted: FeatureRequestInput): string {
  const tenant_id_hash = hashTenantId(input.tenant_id);
  return [
    "### Source",
    `- Type: ${sourceTypeLabel(input.source_type)}`,
    `- Tenant: ${input.tenant_slug} (id hash: ${tenant_id_hash})`,
    "",
    "### What",
    escapeForMarkdown(redacted.what),
    "",
    "### Why",
    escapeForMarkdown(redacted.why),
    "",
    "### Current workaround",
    escapeForMarkdown(redacted.current_workaround),
    "",
    "### Expected usage frequency",
    redacted.expected_usage_frequency ?? "_(not provided)_",
    "",
    "**Help session reference** (platform staff only, requires auth):",
    "",
    `/admin/help/sessions/${input.help_session_id}`,
    "",
    `*Auto-generated by Self-Service Help v1. Submitted at ${input.submitted_at}.*`,
  ].join("\n");
}

async function octokit(): Promise<Octokit> {
  const token = await getInstallationToken();
  return new Octokit({ auth: token });
}

async function createIssue(args: {
  title: string;
  body: string;
  labels: string[];
}): Promise<CreatedIssue> {
  const e = env();
  const client = await octokit();
  try {
    const res = await client.issues.create({
      owner: e.GITHUB_REPO_OWNER,
      repo: e.GITHUB_REPO_NAME,
      title: args.title,
      body: args.body,
      labels: args.labels,
    });
    return { issue_number: res.data.number, issue_url: res.data.html_url };
  } catch (err) {
    const e2 = err as { status?: number; message?: string };
    throw new GitHubAPIError(
      `GitHub issue creation failed: ${e2.message ?? "unknown error"}`,
      "POST /repos/:owner/:repo/issues",
      e2.status,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a GitHub bug issue from a redacted submission.
 *
 * Throws:
 *   - `PIIZeroToleranceQuarantineError` if any zero-tolerance pattern hits.
 *     Caller MUST set `github_issue_state='quarantined'`, populate
 *     `quarantine_reason`, write an audit row, and surface the friendly
 *     "contact platform support directly" message to the user.
 *   - `GitHubAPIError` on any GitHub API failure. Caller's retry harness
 *     handles exponential backoff per §32.7.5.
 */
export async function createBugIssue(input: BugSubmissionInput): Promise<CreatedIssue> {
  // 1. Zero-tolerance scan — throws if SSN/CC/passport hits.
  assertNoZeroTolerancePii({
    where_in_platform: input.where_in_platform,
    actual_behavior: input.actual_behavior,
    expected_behavior: input.expected_behavior,
    steps_to_reproduce: input.steps_to_reproduce,
  });

  // 2. Tolerable redaction (regex pass; Haiku deferred per D-065).
  const redactedFields = redactSubmission({
    where_in_platform: input.where_in_platform,
    actual_behavior: input.actual_behavior,
    expected_behavior: input.expected_behavior,
    steps_to_reproduce: input.steps_to_reproduce,
  });
  const redacted: BugSubmissionInput = {
    ...input,
    where_in_platform: redactedFields.where_in_platform ?? null,
    actual_behavior: redactedFields.actual_behavior ?? null,
    expected_behavior: redactedFields.expected_behavior ?? null,
    steps_to_reproduce: redactedFields.steps_to_reproduce ?? null,
  };

  // 3. Build body + title.
  const title = `[bug] ${truncateForTitle(redacted.actual_behavior) || "Bug report"}`;
  const body = buildBugIssueBody(input, redacted);
  const labels = ["bug", sourceTypeLabel(input.source_type)];

  return createIssue({ title, body, labels });
}

export async function createFeatureIssue(input: FeatureRequestInput): Promise<CreatedIssue> {
  // Zero-tolerance scan also applies to feature requests — keep the
  // contract uniform so a tenant-admin who pastes an SSN into "what" gets
  // the same quarantine path.
  assertNoZeroTolerancePii({
    where_in_platform: input.what,
    actual_behavior: input.why,
    expected_behavior: input.current_workaround,
    steps_to_reproduce: null,
  });

  const redacted: FeatureRequestInput = {
    ...input,
    what: input.what == null ? null : input.what,
    why: input.why == null ? null : input.why,
    current_workaround: input.current_workaround == null ? null : input.current_workaround,
  };
  // Apply tolerable redaction to each text field.
  redacted.what = redactedString(input.what);
  redacted.why = redactedString(input.why);
  redacted.current_workaround = redactedString(input.current_workaround);

  const title = `[feature] ${truncateForTitle(redacted.what) || "Feature request"}`;
  const body = buildFeatureIssueBody(input, redacted);
  const labels = ["feature-request", sourceTypeLabel(input.source_type)];

  return createIssue({ title, body, labels });
}

/**
 * Close an issue with a brief reason comment. Used by the resolution
 * recording path in BP32 (`POST /api/webhooks/github`) and by the
 * platform-admin triage UI for in-band closures.
 */
export async function closeIssue(issue_number: number, reason: string): Promise<void> {
  const e = env();
  const client = await octokit();
  try {
    if (reason && reason.trim().length > 0) {
      await client.issues.createComment({
        owner: e.GITHUB_REPO_OWNER,
        repo: e.GITHUB_REPO_NAME,
        issue_number,
        body: `Closing: ${reason}`,
      });
    }
    await client.issues.update({
      owner: e.GITHUB_REPO_OWNER,
      repo: e.GITHUB_REPO_NAME,
      issue_number,
      state: "closed",
    });
  } catch (err) {
    const e2 = err as { status?: number; message?: string };
    throw new GitHubAPIError(
      `GitHub issue close failed: ${e2.message ?? "unknown error"}`,
      "PATCH /repos/:owner/:repo/issues/:issue_number",
      e2.status,
    );
  }
}

// ---------------------------------------------------------------------------
// Small string helpers — kept private (the BUG_FIELDS export is the public
// contract for which fields run through PII redaction; nothing else here
// is consumer-facing).
// ---------------------------------------------------------------------------

function truncateForTitle(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (trimmed.length <= 70) return trimmed;
  return trimmed.slice(0, 67) + "...";
}

function redactedString(s: string | null | undefined): string | null {
  if (s == null) return null;
  const { redactTolerablePii } = require("@/lib/help-ai/pii-redaction") as typeof import("@/lib/help-ai/pii-redaction");
  return redactTolerablePii(s);
}

// Silence unused-export warning on BUG_FIELDS — re-exported for downstream tests.
export { BUG_FIELDS };
