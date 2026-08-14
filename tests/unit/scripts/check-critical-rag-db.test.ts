import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  criticalMainRlsDecision,
  criticalRagDbDecision,
  MAIN_RLS_CREDENTIALS,
} from "../../../scripts/check-critical-rag-db";

const COMPLETE_MAIN_RLS_CREDENTIALS = {
  NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  SUPABASE_DB_URL: "postgresql://configured",
};

describe("criticalMainRlsDecision", () => {
  it.each(MAIN_RLS_CREDENTIALS)("fails when %s is missing on a non-Dependabot event", (missingName) => {
    expect(
      criticalMainRlsDecision({
        credentials: { ...COMPLETE_MAIN_RLS_CREDENTIALS, [missingName]: "" },
        eventName: "push",
        pullRequestAuthor: undefined,
      }),
    ).toBe("fail");
  });

  it.each(["push", "workflow_dispatch", "merge_group"])(
    "fails with incomplete main credentials on %s",
    (eventName) => {
      expect(
        criticalMainRlsDecision({
          credentials: { ...COMPLETE_MAIN_RLS_CREDENTIALS, NEXT_PUBLIC_SUPABASE_ANON_KEY: "" },
          eventName,
          pullRequestAuthor: undefined,
        }),
      ).toBe("fail");
    },
  );

  it("fails when a human-authored pull request has incomplete main credentials", () => {
    expect(
      criticalMainRlsDecision({
        credentials: { ...COMPLETE_MAIN_RLS_CREDENTIALS, SUPABASE_DB_URL: "   " },
        eventName: "pull_request",
        pullRequestAuthor: "repo-owner",
      }),
    ).toBe("fail");
  });

  it("allows incomplete main credentials only for a Dependabot-authored pull request", () => {
    expect(
      criticalMainRlsDecision({
        credentials: { ...COMPLETE_MAIN_RLS_CREDENTIALS, SUPABASE_DB_URL: "" },
        eventName: "pull_request",
        pullRequestAuthor: "dependabot[bot]",
      }),
    ).toBe("dependabot-exempt");
  });

  it("runs when every main RLS credential is present", () => {
    expect(
      criticalMainRlsDecision({
        credentials: COMPLETE_MAIN_RLS_CREDENTIALS,
        eventName: "merge_group",
        pullRequestAuthor: undefined,
      }),
    ).toBe("run");
  });
});

describe("criticalRagDbDecision", () => {
  it.each([
    ["pull_request", "repo-owner"],
    ["pull_request", "fork-contributor"],
    ["push", "repo-owner"],
    ["merge_group", "github-merge-queue"],
    ["workflow_dispatch", "repo-owner"],
  ])("fails without the RAG DB URL for %s by %s", (eventName, pullRequestAuthor) => {
    expect(criticalRagDbDecision({ dbUrl: "", eventName, pullRequestAuthor })).toBe("fail");
  });

  it("allows a missing URL only for a Dependabot-authored pull request", () => {
    expect(
      criticalRagDbDecision({
        dbUrl: "",
        eventName: "pull_request",
        pullRequestAuthor: "dependabot[bot]",
      }),
    ).toBe("dependabot-exempt");
  });

  it("runs even for Dependabot when the URL is available", () => {
    expect(
      criticalRagDbDecision({
        dbUrl: "postgresql://configured",
        eventName: "pull_request",
        pullRequestAuthor: "dependabot[bot]",
      }),
    ).toBe("run");
  });
});

describe("deploy workflow wiring", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
  const nightly = fs.readFileSync(path.join(root, ".github/workflows/nightly-full-test.yml"), "utf8");

  it("preflights every main RLS credential before invoking the suite", () => {
    for (const line of [
      "NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.SUPABASE_TEST_URL }}",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_TEST_ANON_KEY }}",
      "SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_TEST_SERVICE_KEY }}",
      "SUPABASE_DB_URL: ${{ secrets.SUPABASE_TEST_DB_URL }}",
    ]) {
      expect(workflow).toContain(line);
    }
    expect(workflow.indexOf("pnpm tsx scripts/check-critical-rag-db.ts")).toBeLessThan(
      workflow.indexOf("pnpm vitest run apps/main/test/integration/rls.test.ts"),
    );
    expect(workflow).toContain("if: steps.isolation-db-preflight.outputs.run_main_rls == 'true'");
  });

  it("retains the preflight output gate on the seeded RAG suite", () => {
    expect(workflow).toContain("pnpm tsx scripts/check-critical-rag-db.ts");
    expect(workflow).toContain("if: steps.isolation-db-preflight.outputs.run_rag_scope == 'true'");
    expect(workflow).toContain("RAG_SCOPE_DB_REQUIRED: \"true\"");
    expect(workflow).toContain("test/integration/retrieval-scope-isolation.test.ts");
  });

  it("runs this workflow-wiring fixture on workflow-only pull requests", () => {
    const testJob = workflow.slice(workflow.indexOf("\n  test:"), workflow.indexOf("\n  secret-scan:"));
    const testJobHeader = testJob.slice(0, testJob.indexOf("    steps:"));
    const preflightStep = testJob.slice(
      testJob.indexOf("      - name: Require critical isolation test databases for workflow-only changes"),
      testJob.indexOf("      - name: Decide test scope"),
    );
    expect(testJobHeader).not.toContain("workflows_only != 'true'");
    expect(testJobHeader).not.toContain("SUPABASE_DB_URL:");
    expect(testJobHeader).not.toContain("SUPABASE_RAG_DB_URL:");
    expect(testJob).toContain("if: needs.detect-changes.outputs.workflows_only == 'true'");
    expect(testJob).toContain("pnpm vitest run tests/unit/scripts/check-critical-rag-db.test.ts");
    for (const line of [
      "NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.SUPABASE_TEST_URL }}",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_TEST_ANON_KEY }}",
      "SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_TEST_SERVICE_KEY }}",
      "SUPABASE_DB_URL: ${{ secrets.SUPABASE_TEST_DB_URL }}",
      "SUPABASE_RAG_DB_URL: ${{ secrets.SUPABASE_RAG_TEST_DB_URL }}",
      "ISOLATION_PR_AUTHOR: ${{ github.event.pull_request.user.login }}",
    ]) {
      expect(preflightStep).toContain(line);
    }
    expect(preflightStep).toContain("pnpm tsx scripts/check-critical-rag-db.ts");
    expect(testJob.indexOf("pnpm vitest run tests/unit/scripts/check-critical-rag-db.test.ts")).toBeLessThan(
      testJob.indexOf("pnpm tsx scripts/check-critical-rag-db.ts"),
    );
  });

  it("keeps live isolation suites in the serialized integration job", () => {
    const integrationJob = workflow.slice(workflow.indexOf("\n  integration-tests-critical:"), workflow.indexOf("\n  contract-tests:"));
    expect(integrationJob).toContain("concurrency:\n      group: shared-test-db\n      cancel-in-progress: false");
    expect(integrationJob).toContain("SUPABASE_DB_URL: ${{ secrets.SUPABASE_TEST_DB_URL }}");
    expect(integrationJob).toContain("SUPABASE_RAG_DB_URL: ${{ secrets.SUPABASE_RAG_TEST_DB_URL }}");
    expect(integrationJob).toContain("pnpm vitest run apps/main/test/integration/rls.test.ts");
    expect(integrationJob).toContain("test/integration/retrieval-scope-isolation.test.ts");
  });

  it("reports missing API or DB credentials from scheduled and manual nightly runs", () => {
    for (const line of [
      "NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.SUPABASE_TEST_URL }}",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_TEST_ANON_KEY }}",
      "SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_TEST_SERVICE_KEY }}",
      "SUPABASE_DB_URL: ${{ secrets.SUPABASE_TEST_DB_URL }}",
      "SUPABASE_RAG_DB_URL: ${{ secrets.SUPABASE_RAG_TEST_DB_URL }}",
    ]) {
      expect(nightly).toContain(line);
    }
    expect(nightly).toContain("pnpm tsx scripts/check-critical-rag-db.ts");
    expect(nightly).toContain("ISOLATION_PREFLIGHT_STATUS: ${{ steps.isolation-preflight.outputs.exit_status }}");
    expect(nightly).toContain("Critical isolation credential preflight FAILED");
  });
});
