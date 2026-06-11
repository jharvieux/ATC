/**
 * §30.8 BP30 live-dispatch (Tier 2) — event-payload contract probe.
 *
 * Asserts the §11.2.2 contract at runtime: every event-triggered
 * tenant-scoped handler MUST derive tenant_id from event.data.tenant_id
 * and ONLY from event.data.tenant_id. The static probe (Tier 0) checks
 * the import shape; this live probe verifies the runtime behaviour.
 *
 * Two shapes of contract enforcement live in the codebase today:
 *
 *   1. Centralised via tenantContextFromInngestEvent — throws a
 *      structured error when tenant_id is missing. Handlers using it
 *      fail loudly. This suite asserts the throw.
 *
 *   2. Inline guards — handler checks `data?.tenant_id` itself and
 *      returns `{ skipped: "..." }`. Slightly looser shape but the
 *      same security property. This suite asserts the skip.
 *
 * Handlers that DON'T enforce centrally (a third shape: read
 * event.data.tenant_id directly + pass to createServiceRoleClient
 * calls with manual .eq filters) are flagged as TODO findings rather
 * than tested — fixing them is a separate refactor.
 */

import { describe, expect, it } from "vitest";
import { TEST_ANON_JWT, TEST_SERVICE_ROLE_JWT } from "./_test-jwt-fixtures";

const haveTier2 = Boolean(process.env.SUPABASE_DB_URL);
const describeIf = haveTier2 ? describe : describe.skip;

if (haveTier2) {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= TEST_ANON_JWT;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= TEST_SERVICE_ROLE_JWT;
  process.env.INNGEST_EVENT_KEY ??= "tier2-test-eventkey";
  // extract-memory's runtime needs ANTHROPIC_API_KEY to load env, but the
  // negative-tenant-id test fires BEFORE any vendor call; placeholder OK.
  process.env.ANTHROPIC_API_KEY ??= "sk-ant-tier2-placeholder";
}

import { invokeInngestHandler } from "./_inngest-invoke";
import { inngest } from "@/inngest/client";
import { extractMemory } from "@/inngest/extract-memory";
import { githubIssueRetry } from "@/inngest/github-issue-retry";
import { abuseStateTransitionNotify } from "@/inngest/abuse-state-transition-notify";

(inngest as unknown as { send: (e: unknown) => Promise<unknown> }).send = async () => ({ ids: [] });

describeIf("BP30 Tier 2 — event-payload contract (centralised enforcement)", () => {
  // ── Handlers using tenantContextFromInngestEvent → throws on missing.
  const centralisedHandlers = [
    { name: "extractMemory", fn: extractMemory, eventName: "conversation.memory_extract_requested" },
  ];

  it.each(centralisedHandlers)(
    "$name throws when event.data.tenant_id is missing",
    async ({ fn, eventName }) => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        invokeInngestHandler(fn as any, {
          name: eventName,
          data: { /* deliberately no tenant_id */ },
        }),
      ).rejects.toThrow(/tenant_id is missing|tenantContextFromInngestEvent/);
    },
  );

  it.each(centralisedHandlers)(
    "$name throws when event.data.tenant_id is non-string",
    async ({ fn, eventName }) => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        invokeInngestHandler(fn as any, {
          name: eventName,
          data: { tenant_id: 12345 as unknown as string },
        }),
      ).rejects.toThrow(/tenant_id/);
    },
  );
});

describeIf("BP30 Tier 2 — event-payload contract (Zod-schema enforcement)", () => {
  // ── githubIssueRetry validates event.data with a Zod schema BEFORE
  // tenantContextFromInngestEvent runs (#840 / PR #945): an invalid
  // payload returns { skipped: true, reason: "invalid_payload" } instead
  // of throwing, so a permanently-malformed event can't trigger infinite
  // Inngest retries. Same security property — no tenant-scoped work
  // happens without a valid string tenant_id — different failure shape.
  const invalidPayloads = [
    { label: "missing", data: { /* deliberately no tenant_id */ } },
    { label: "non-string", data: { tenant_id: 12345 as unknown as string } },
  ];

  it.each(invalidPayloads)(
    "githubIssueRetry skips without dispatching when event.data.tenant_id is $label",
    async ({ data }) => {
      const { result } = await invokeInngestHandler<{ skipped?: boolean; reason?: string }>(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        githubIssueRetry as any,
        { name: "help.github_issue_creation_failed", data },
      );
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe("invalid_payload");
    },
  );
});

describeIf("BP30 Tier 2 — event-payload contract (inline-guard enforcement)", () => {
  // abuseStateTransitionNotify uses its own data-shape guard rather than
  // tenantContextFromInngestEvent because it also needs `dimension` and
  // `to_state` to be present — both checked together. Returns
  // `{ skipped: "missing-payload-fields" }` rather than throwing.
  it("abuseStateTransitionNotify skips with no audit row when tenant_id is missing", async () => {
    const { result } = await invokeInngestHandler<{ skipped?: string }>(
      abuseStateTransitionNotify,
      { name: "abuse.state_transition", data: { dimension: "ai_cost", to_state: "soft1" } },
    );
    expect(result.skipped).toBe("missing-payload-fields");
  });

  it("abuseStateTransitionNotify skips with no audit row when dimension is missing", async () => {
    const { result } = await invokeInngestHandler<{ skipped?: string }>(
      abuseStateTransitionNotify,
      { name: "abuse.state_transition", data: { tenant_id: "22222222-0000-0000-0000-0000000000a1", to_state: "soft1" } },
    );
    expect(result.skipped).toBe("missing-payload-fields");
  });

  it("abuseStateTransitionNotify skips with no audit row when to_state is missing", async () => {
    const { result } = await invokeInngestHandler<{ skipped?: string }>(
      abuseStateTransitionNotify,
      { name: "abuse.state_transition", data: { tenant_id: "22222222-0000-0000-0000-0000000000a1", dimension: "ai_cost" } },
    );
    expect(result.skipped).toBe("missing-payload-fields");
  });

  it("abuseStateTransitionNotify skips with no audit row when to_state is 'ok' (upward-only notifications)", async () => {
    const { result } = await invokeInngestHandler<{ skipped?: string }>(
      abuseStateTransitionNotify,
      { name: "abuse.state_transition", data: { tenant_id: "22222222-0000-0000-0000-0000000000a1", dimension: "ai_cost", to_state: "ok" } },
    );
    expect(result.skipped).toBe("no-notify-on-ok");
  });
});

// Documented finding (not a test failure — a follow-up):
//
//   - tenantTerminationScheduled + tenantOnTerminatedSideEffects (both
//     in apps/main/src/inngest/tenant-on-terminated.ts) read
//     `event.data.tenant_id` directly into a string variable then pass
//     it to `createServiceRoleClient().from(...).eq("id", tenant_id)`
//     filters. There's no central guard — missing tenant_id results in
//     a string "undefined" being filtered against, which silently
//     matches 0 rows rather than throwing. Recommend refactoring to
//     use `tenantContextFromInngestEvent` for consistency with the
//     other tenant-scoped handlers.
