import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function loadWorkflow(): string {
  const ref = process.env.DEPLOY_WORKFLOW_REF;
  if (!ref) return fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
  const result = spawnSync("git", ["show", `${ref}:.github/workflows/deploy.yml`], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

interface WorkflowStep {
  name: string;
  body: string;
}

interface WorkflowJob {
  id: string;
  body: string;
  needs: string[];
  ifExpression?: string;
  concurrencyGroup?: string;
  cancelInProgress?: boolean;
  steps: WorkflowStep[];
}

function parseWorkflowJobs(source: string): Map<string, WorkflowJob> {
  const jobsSource = source.slice(source.indexOf("\njobs:") + 6);
  const starts = [...jobsSource.matchAll(/^  ([a-z0-9-]+):\n/gm)];
  const jobs = new Map<string, WorkflowJob>();
  for (const [index, match] of starts.entries()) {
    const id = match[1];
    const body = jobsSource.slice(match.index, starts[index + 1]?.index ?? jobsSource.length);
    const inlineNeeds = body.match(/^    needs:\s*\[([^\]]*)\]/m)?.[1];
    const blockNeeds = body.match(/^    needs:\s*\n([\s\S]*?)(?=^    [a-z-]+:)/m)?.[1];
    const needs = (inlineNeeds ?? blockNeeds ?? "").match(/[a-z][a-z0-9-]*/g) ?? [];
    const stepStarts = [...body.matchAll(/^      - name:\s*(.+)\n/gm)];
    const steps = stepStarts.map((step, stepIndex) => ({
      name: step[1].trim(),
      body: body.slice(step.index, stepStarts[stepIndex + 1]?.index ?? body.length),
    }));
    const rawInlineIf = body.match(/^    if:[ \t]*(.*)$/m)?.[1].trim();
    const inlineIf = rawInlineIf === "|" ? undefined : rawInlineIf;
    const blockIf = body.match(/^    if:\s*\|\n((?:      .*\n)+)/m)?.[1];
    const group = body.match(/^      group:\s*([^\n]+)$/m)?.[1].trim();
    const cancel = body.match(/^      cancel-in-progress:\s*(true|false)$/m)?.[1];
    jobs.set(id, {
      id,
      body,
      needs,
      ifExpression: (inlineIf ?? blockIf)?.replace(/\s+/g, " ").trim(),
      concurrencyGroup: group,
      cancelInProgress: cancel === undefined ? undefined : cancel === "true",
      steps,
    });
  }
  return jobs;
}

type Actor = "branch-a" | "branch-b" | "release";
type Operation =
  | "reset-main"
  | "apply-main"
  | "accept-main"
  | "reset-rag"
  | "apply-rag"
  | "accept-rag"
  | "copy-prod"
  | "apply-release"
  | "consume-release";

const mainAcceptanceCommands = [
  "pnpm vitest run apps/main/test/integration/rls.test.ts",
  "pnpm vitest run apps/main/test/integration/stripe-webhook.test.ts",
];
const ragAcceptanceCommand = "test/integration/retrieval-scope-isolation.test.ts";
const remainingAcceptanceCommands = [
  "pnpm vitest run tests/integration/scripts/check-ledger-objects-db.test.ts",
  "pnpm test:cross-tenant",
];
const liveAcceptanceCommands = [...mainAcceptanceCommands, ragAcceptanceCommand, ...remainingAcceptanceCommands];

function jobOperations(job: WorkflowJob): Operation[] {
  const operations: Operation[] = [];
  for (const step of job.steps) {
    if (step.name.startsWith("Reset main test DB")) operations.push("reset-main");
    if (step.name.startsWith("Reset RAG test DB")) operations.push("reset-rag");
    if (step.name === "Apply main app migrations to test DB") operations.push("apply-main");
    if (step.name === "Apply RAG app migrations to test DB") operations.push("apply-rag");
    if ([...mainAcceptanceCommands, ...remainingAcceptanceCommands].some((command) => step.body.includes(command))) {
      operations.push("accept-main");
    }
    if (step.body.includes(ragAcceptanceCommand)) operations.push("accept-rag");
    if (step.name === "Reset staging public schema and restore") operations.push("copy-prod");
    if (step.name === "Apply Supabase migrations") operations.push("apply-release");
    if (step.body.includes("npx playwright test") || step.body.includes("curl -f https://staging.ai-travelconcierge.com/api/health")) {
      operations.push("consume-release");
    }
  }
  return operations;
}

interface ScheduledJob {
  actor: Actor;
  job: WorkflowJob;
  operations: Operation[];
}

function enumerateSchedules(jobs: ScheduledJob[]): ScheduledJob[][] {
  const schedules: ScheduledJob[][] = [];
  function visit(remaining: ScheduledJob[], completed: Set<string>, schedule: ScheduledJob[]): void {
    if (remaining.length === 0) {
      schedules.push(schedule);
      return;
    }
    for (const candidate of remaining) {
      const sameActorIds = new Set(jobs.filter((entry) => entry.actor === candidate.actor).map((entry) => entry.job.id));
      if (candidate.job.needs.some((need) => sameActorIds.has(need) && !completed.has(`${candidate.actor}:${need}`))) continue;
      visit(
        remaining.filter((entry) => entry !== candidate),
        new Set(completed).add(`${candidate.actor}:${candidate.job.id}`),
        [...schedule, candidate],
      );
    }
  }
  visit(jobs, new Set(), []);
  return schedules;
}

function unsafeSchedule(schedules: ScheduledJob[][], mainPolicyOnly = false): string[] | undefined {
  for (const schedule of schedules) {
    let mainBase: string | undefined;
    let mainPolicy: string | undefined;
    let ragPolicy: string | undefined;
    let unsafe = false;
    for (const entry of schedule) {
      for (const operation of entry.operations) {
        if (operation === "reset-main") {
          mainBase = `empty-for-${entry.actor}`;
          mainPolicy = undefined;
        } else if (operation === "apply-main") {
          mainPolicy = `main-policy-${entry.actor}`;
        } else if (operation === "accept-main" && mainPolicy !== `main-policy-${entry.actor}`) {
          unsafe = true;
        } else if (!mainPolicyOnly && operation === "reset-rag") {
          ragPolicy = undefined;
        } else if (!mainPolicyOnly && operation === "apply-rag") {
          ragPolicy = `rag-policy-${entry.actor}`;
        } else if (!mainPolicyOnly && operation === "accept-rag" && ragPolicy !== `rag-policy-${entry.actor}`) {
          unsafe = true;
        } else if (!mainPolicyOnly && operation === "copy-prod") {
          mainBase = "prod-copy-for-release";
          mainPolicy = "main-policy-release";
        } else if (!mainPolicyOnly && operation === "apply-release") {
          mainPolicy = mainPolicy?.startsWith("main-policy-branch") ? `${mainPolicy}-plus-release` : "main-policy-release";
        } else if (!mainPolicyOnly && operation === "consume-release" && mainBase !== "prod-copy-for-release") {
          unsafe = true;
        }
      }
    }
    if (unsafe) return schedule.map((entry) => `${entry.actor}:${entry.job.id}`);
  }
  return undefined;
}

function step(job: WorkflowJob | undefined, name: string): WorkflowStep {
  const found = job?.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${job?.id ?? "missing job"} has no '${name}' step`);
  return found;
}

function stepScript(workflowStep: WorkflowStep): string {
  const marker = "        run: |\n";
  const start = workflowStep.body.indexOf(marker);
  if (start === -1) throw new Error(`${workflowStep.name} has no block run script`);
  return workflowStep.body
    .slice(start + marker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n")
    .trimEnd();
}

const tempDirs: string[] = [];

function runStep(workflowStep: WorkflowStep, env: NodeJS.ProcessEnv = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-provenance-"));
  tempDirs.push(tempDir);
  const outputPath = path.join(tempDir, "github-output");
  fs.writeFileSync(outputPath, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", stepScript(workflowStep)], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: outputPath, ...env },
  });
  return { ...result, output: fs.readFileSync(outputPath, "utf8") };
}

interface HolderArrival {
  actor: Actor;
  job: WorkflowJob;
}

const workflow = loadWorkflow();
const jobs = parseWorkflowJobs(workflow);
const provenanceHolder = jobs.get("rls-snapshot-diff");
const integrationReceipt = jobs.get("integration-tests-critical");
const crossTenantReceipt = jobs.get("cross-tenant-probe");
const dbCopy = jobs.get("db-copy");
const deployStaging = jobs.get("deploy-staging");

afterEach(() => {
  for (const directory of tempDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("deploy shared-test-DB provenance", () => {
  it("derives a safe two-PR branch-policy schedule from the actual job graph", () => {
    const branchJobs = [...jobs.values()].filter((job) => jobOperations(job).some((operation) => operation.includes("main") || operation.includes("rag")));
    const scheduled = (["branch-a", "branch-b"] as const).flatMap((actor) =>
      branchJobs.map((job) => ({ actor, job, operations: jobOperations(job) })),
    );
    const counterexample = unsafeSchedule(enumerateSchedules(scheduled), true);
    expect(counterexample, `unsafe branch-policy schedule: ${counterexample?.join(" -> ")}`).toBeUndefined();
    const ragCounterexample = unsafeSchedule(enumerateSchedules(scheduled));
    expect(ragCounterexample, `unsafe RAG-policy schedule: ${ragCounterexample?.join(" -> ")}`).toBeUndefined();
    expect(branchJobs.map((job) => job.id)).toEqual(["rls-snapshot-diff"]);
    for (const job of branchJobs) {
      expect(job.concurrencyGroup).toBe("shared-test-db");
      expect(job.cancelInProgress).toBe(false);
    }
  });

  it("keeps both exact-revision applies, snapshots, and every live acceptance in one holder", () => {
    expect(provenanceHolder?.concurrencyGroup).toBe("shared-test-db");
    expect(provenanceHolder?.cancelInProgress).toBe(false);
    const holderBody = provenanceHolder?.body ?? "";
    const orderedEvidence = [
      "Reset main test DB before apply",
      "Apply main app migrations to test DB",
      "Reset RAG test DB before apply",
      "Apply RAG app migrations to test DB",
      "Check RLS drift",
      "Check grants drift",
      ...mainAcceptanceCommands,
      ragAcceptanceCommand,
      ...remainingAcceptanceCommands,
      "Record revision provenance",
    ];
    let previous = -1;
    for (const evidence of orderedEvidence) {
      const position = holderBody.indexOf(evidence);
      expect(position, `${evidence} belongs to the uninterrupted holder`).toBeGreaterThan(previous);
      previous = position;
    }

    for (const command of liveAcceptanceCommands) {
      expect(integrationReceipt?.body).not.toContain(command);
      expect(crossTenantReceipt?.body).not.toContain(command);
    }
    for (const wiring of [
      "NEXT_PUBLIC_SUPABASE_URL: ${{ secrets.SUPABASE_TEST_URL }}",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ secrets.SUPABASE_TEST_ANON_KEY }}",
      "SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_TEST_SERVICE_KEY }}",
      "SUPABASE_DB_URL: ${{ secrets.SUPABASE_TEST_DB_URL }}",
      "SUPABASE_RAG_DB_URL: ${{ secrets.SUPABASE_RAG_TEST_DB_URL }}",
      "APP_BASE_URL: ${{ secrets.APP_STAGING_URL }}",
      'CROSS_TENANT_FIXTURES: "true"',
      "STRIPE_SECRET_KEY: sk_test_ci-placeholder",
      "STRIPE_WEBHOOK_SECRET: whsec_ci-placeholder",
      'MAIN_RLS_DB_REQUIRED: "true"',
      'RAG_SCOPE_DB_REQUIRED: "true"',
      "contents: read",
      "issues: write",
    ]) {
      expect(holderBody).toContain(wiring);
    }
  });

  it("derives a safe copy-through-staging-consumption schedule from the actual graph", () => {
    expect(dbCopy?.concurrencyGroup).toBe("shared-test-db");
    expect(dbCopy?.cancelInProgress).toBe(false);
    expect(dbCopy?.ifExpression).toBe(
      "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && startsWith(github.ref, 'refs/heads/release/') && vars.STAGING_PIPELINE_ENABLED == 'true'",
    );
    expect(jobOperations(dbCopy as WorkflowJob)).toEqual([
      "copy-prod",
      "apply-release",
      "consume-release",
      "consume-release",
    ]);
    for (const wiring of [
      "environment: staging",
      "PROD_DB_URL: ${{ secrets.PROD_DB_URL }}",
      "DB_URL: ${{ secrets.DB_URL }}",
      "VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}",
      "VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}",
      "VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}",
      "TEST_OVERRIDE_EMAIL: ${{ secrets.TEST_OVERRIDE_EMAIL }}",
      "TEST_OVERRIDE_PHONE: ${{ secrets.TEST_OVERRIDE_PHONE }}",
      "BASE_URL: https://staging.ai-travelconcierge.com",
      "ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY_TEST }}",
      "TEST_E2E_OWNER_EMAIL: ${{ secrets.TEST_E2E_OWNER_EMAIL }}",
      "TEST_E2E_OWNER_PASSWORD: ${{ secrets.TEST_E2E_OWNER_PASSWORD }}",
    ]) {
      expect(dbCopy?.body).toContain(wiring);
    }
    const releaseJobs = [dbCopy, deployStaging]
      .filter((job): job is WorkflowJob => job !== undefined)
      .filter((job) => jobOperations(job).length > 0)
      .map((job) => ({ actor: "release" as const, job, operations: jobOperations(job) }));
    const prJob = {
      actor: "branch-a" as const,
      job: provenanceHolder as WorkflowJob,
      operations: jobOperations(provenanceHolder as WorkflowJob),
    };
    const counterexample = unsafeSchedule(enumerateSchedules([...releaseJobs, prJob]));
    expect(counterexample, `unsafe staging schedule: ${counterexample?.join(" -> ")}`).toBeUndefined();
  });

  it("preserves required contexts as always-run fail-closed receipts", () => {
    for (const receipt of [integrationReceipt, crossTenantReceipt, deployStaging]) {
      expect(receipt?.ifExpression).toContain("always()");
      expect(receipt?.body).toContain("_RESULT");
      expect(receipt?.body).toContain("outputs.verified_sha");
      expect(receipt?.body).toContain('if [ -z "$VERIFIED_SHA" ] || [ "$VERIFIED_SHA" != "$EXPECTED_SHA" ]');
      expect(receipt?.body).toContain("Revision provenance missing or stale");
      expect(jobOperations(receipt as WorkflowJob)).toEqual([]);
    }
    expect(integrationReceipt?.needs).toEqual(["detect-changes", "rls-snapshot-diff"]);
    expect(crossTenantReceipt?.needs).toEqual([
      "detect-changes",
      "typecheck",
      "lint",
      "test",
      "secret-scan",
      "rls-snapshot-diff",
    ]);
    expect(deployStaging?.needs).toEqual(["db-copy"]);
    expect(integrationReceipt?.ifExpression).toBe(
      "always() && (needs.detect-changes.result != 'success' || ((github.event_name != 'pull_request' || needs.detect-changes.outputs.code == 'true') && needs.detect-changes.outputs.workflows_only != 'true'))",
    );
    expect(crossTenantReceipt?.ifExpression).toBe(integrationReceipt?.ifExpression);
    expect(deployStaging?.ifExpression).toBe(
      "always() && (github.event_name == 'push' || github.event_name == 'workflow_dispatch') && startsWith(github.ref, 'refs/heads/release/') && vars.STAGING_PIPELINE_ENABLED == 'true'",
    );
  });

  it("executes receipt shells fail-closed for dependency and exact-SHA failures", () => {
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const common = {
      DETECT_RESULT: "success",
      HOLDER_RESULT: "success",
      EXPECTED_SHA: sha,
      VERIFIED_SHA: sha,
      ACCEPTANCE_MODE: "live",
      EVENT_NAME: "push",
      PR_AUTHOR: "",
    };
    const integrationScript = step(integrationReceipt, "Verify exact tested revision");
    expect(runStep(integrationScript, common).status).toBe(0);
    expect(runStep(integrationScript, { ...common, HOLDER_RESULT: "cancelled" }).status).not.toBe(0);
    expect(runStep(integrationScript, { ...common, VERIFIED_SHA: "stale" }).status).not.toBe(0);

    const crossTenantScript = step(crossTenantReceipt, "Verify exact tested revision");
    const crossTenantDependencies = {
      ...common,
      TYPECHECK_RESULT: "success",
      LINT_RESULT: "success",
      TEST_RESULT: "success",
      SECRET_SCAN_RESULT: "success",
    };
    expect(runStep(crossTenantScript, crossTenantDependencies).status).toBe(0);
    expect(runStep(crossTenantScript, { ...crossTenantDependencies, TEST_RESULT: "skipped" }).status).not.toBe(0);
    expect(runStep(crossTenantScript, { ...crossTenantDependencies, HOLDER_RESULT: "cancelled" }).status).not.toBe(0);

    const stagingScript = step(deployStaging, "Verify exact staged revision");
    expect(runStep(stagingScript, common).status).toBe(0);
    expect(runStep(stagingScript, { ...common, HOLDER_RESULT: "failure" }).status).not.toBe(0);
    expect(runStep(stagingScript, { ...common, VERIFIED_SHA: "stale" }).status).not.toBe(0);

    const stagingProvenance = step(dbCopy, "Record staging revision provenance");
    const staged = runStep(stagingProvenance, { GITHUB_SHA: sha });
    expect(staged.status, `${staged.stdout}\n${staged.stderr}`).toBe(0);
    expect(staged.output).toBe(`verified_sha=${sha}\n`);
    expect(runStep(stagingProvenance, { GITHUB_SHA: "stale" }).status).not.toBe(0);
  });

  it("distinguishes Dependabot exemptions from live acceptance in receipt output", () => {
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const dependabot = {
      DETECT_RESULT: "success",
      HOLDER_RESULT: "success",
      EXPECTED_SHA: sha,
      VERIFIED_SHA: sha,
      ACCEPTANCE_MODE: "dependabot-exempt",
      EVENT_NAME: "pull_request",
      PR_AUTHOR: "dependabot[bot]",
    };
    for (const receipt of [integrationReceipt, crossTenantReceipt]) {
      const result = runStep(step(receipt, "Verify exact tested revision"), {
        ...dependabot,
        TYPECHECK_RESULT: "success",
        LINT_RESULT: "success",
        TEST_RESULT: "success",
        SECRET_SCAN_RESULT: "success",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("no live");
      expect(result.stdout).not.toMatch(/^Live .* acceptance passed/m);
    }
    expect(
      runStep(step(integrationReceipt, "Verify exact tested revision"), { ...dependabot, PR_AUTHOR: "repo-owner" }).status,
    ).not.toBe(0);
  });

  it("publishes live evidence only after main, RAG, and cross-tenant live modes ran", () => {
    expect(provenanceHolder?.body).toContain("steps.isolation-db-preflight.outputs.run_main_rls");
    expect(provenanceHolder?.body).toContain("steps.isolation-db-preflight.outputs.run_rag_scope");
    expect(provenanceHolder?.body).toContain("steps.cross-tenant-preflight.outputs.run_cross_tenant");
    expect(provenanceHolder?.body).toContain("acceptance_mode=dependabot-exempt");
    expect(provenanceHolder?.body).not.toContain("tested_sha=");

    const preflight = step(provenanceHolder, "Require live cross-tenant probe inputs");
    const livePreflight = runStep(preflight, {
      NEXT_PUBLIC_SUPABASE_URL: "https://db.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
      APP_BASE_URL: "https://app.example.test",
      CROSS_TENANT_FIXTURES: "true",
      EVENT_NAME: "merge_group",
      PR_AUTHOR: "",
    });
    expect(livePreflight.status, `${livePreflight.stdout}\n${livePreflight.stderr}`).toBe(0);
    expect(livePreflight.output).toBe("run_cross_tenant=true\n");
    expect(runStep(preflight, { EVENT_NAME: "push", PR_AUTHOR: "" }).status).not.toBe(0);
    const dependabotPreflight = runStep(preflight, {
      EVENT_NAME: "pull_request",
      PR_AUTHOR: "dependabot[bot]",
    });
    expect(dependabotPreflight.status).toBe(0);
    expect(dependabotPreflight.output).toBe("run_cross_tenant=false\n");

    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const provenance = step(provenanceHolder, "Record revision provenance");
    const liveProvenance = runStep(provenance, {
      GITHUB_SHA: sha,
      MAIN_MODE: "true",
      RAG_MODE: "true",
      CROSS_TENANT_MODE: "true",
      EVENT_NAME: "merge_group",
      PR_AUTHOR: "",
    });
    expect(liveProvenance.status, `${liveProvenance.stdout}\n${liveProvenance.stderr}`).toBe(0);
    expect(liveProvenance.output).toBe(`acceptance_mode=live\nverified_sha=${sha}\n`);
    expect(
      runStep(provenance, {
        GITHUB_SHA: sha,
        MAIN_MODE: "true",
        RAG_MODE: "false",
        CROSS_TENANT_MODE: "true",
        EVENT_NAME: "push",
        PR_AUTHOR: "",
      }).status,
    ).not.toBe(0);
    const dependabotProvenance = runStep(provenance, {
      GITHUB_SHA: sha,
      MAIN_MODE: "false",
      RAG_MODE: "false",
      CROSS_TENANT_MODE: "false",
      EVENT_NAME: "pull_request",
      PR_AUTHOR: "dependabot[bot]",
    });
    expect(dependabotProvenance.status).toBe(0);
    expect(dependabotProvenance.output).toBe(`acceptance_mode=dependabot-exempt\nverified_sha=${sha}\n`);
    expect(
      runStep(provenance, {
        GITHUB_SHA: "stale",
        MAIN_MODE: "true",
        RAG_MODE: "true",
        CROSS_TENANT_MODE: "true",
        EVENT_NAME: "push",
        PR_AUTHOR: "",
      }).status,
    ).not.toBe(0);
  });

  it("covers every event path without contradictory holder gates", () => {
    const triggers = workflow.slice(0, workflow.indexOf("\njobs:"));
    expect(triggers).toContain("pull_request:");
    expect(triggers).toContain("merge_group:");
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).toContain("- dev");
    expect(triggers.match(/- "release\/\*"/g)).toHaveLength(2);
    expect(provenanceHolder?.ifExpression).toBe(
      "(github.event_name != 'pull_request' || needs.detect-changes.outputs.code == 'true') && needs.detect-changes.outputs.workflows_only != 'true'",
    );
    const scenarios = [
      { eventName: "pull_request", code: true, workflowsOnly: false, expected: true },
      { eventName: "pull_request", code: false, workflowsOnly: false, expected: false },
      { eventName: "pull_request", code: true, workflowsOnly: true, expected: false },
      { eventName: "merge_group", code: false, workflowsOnly: false, expected: true },
      { eventName: "push", code: false, workflowsOnly: false, expected: true },
      { eventName: "workflow_dispatch", code: false, workflowsOnly: false, expected: true },
    ];
    expect(scenarios.map(({ eventName, code, workflowsOnly }) => (eventName !== "pull_request" || code) && !workflowsOnly)).toEqual(
      scenarios.map(({ expected }) => expected),
    );
    expect(provenanceHolder?.body).toContain("github.event_name == 'workflow_dispatch'");
    expect(provenanceHolder?.body).toContain("github.event_name == 'push' && github.ref == 'refs/heads/dev'");
    expect(provenanceHolder?.body).toContain("startsWith(github.ref, 'refs/heads/release/')");
  });

  it("never cancels an active holder when a third run replaces the pending run", () => {
    expect(provenanceHolder?.concurrencyGroup).toBe("shared-test-db");
    expect(provenanceHolder?.cancelInProgress).toBe(false);
    expect(dbCopy?.concurrencyGroup).toBe("shared-test-db");
    expect(dbCopy?.cancelInProgress).toBe(false);
    const arrivals: HolderArrival[] = [
      { actor: "branch-a", job: provenanceHolder as WorkflowJob },
      { actor: "branch-b", job: provenanceHolder as WorkflowJob },
      { actor: "release", job: dbCopy as WorkflowJob },
    ];
    let active: HolderArrival | undefined;
    let pending: HolderArrival | undefined;
    const canceled: HolderArrival[] = [];
    for (const arrival of arrivals) {
      if (!active) {
        active = arrival;
      } else if (arrival.job.concurrencyGroup !== active.job.concurrencyGroup) {
        throw new Error(`${arrival.job.id} does not share ${active.job.id}'s concurrency group`);
      } else if (arrival.job.cancelInProgress) {
        canceled.push(active);
        active = arrival;
      } else {
        if (pending) canceled.push(pending);
        pending = arrival;
      }
    }
    const queue = { active, pending, canceled };
    expect(queue.active?.actor).toBe("branch-a");
    expect(queue.canceled.map((arrival) => arrival.actor)).toEqual(["branch-b"]);
    expect(queue.pending?.actor).toBe("release");
  });
});
