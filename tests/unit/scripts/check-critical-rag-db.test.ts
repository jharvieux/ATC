import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { criticalRagDbDecision } from "../../../scripts/check-critical-rag-db";

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

  it("retains the preflight output gate on the seeded RAG suite", () => {
    expect(workflow).toContain("pnpm tsx scripts/check-critical-rag-db.ts");
    expect(workflow).toContain("if: steps.rag-db-preflight.outputs.run_rag_scope == 'true'");
    expect(workflow).toContain("RAG_SCOPE_DB_REQUIRED: \"true\"");
    expect(workflow).toContain("test/integration/retrieval-scope-isolation.test.ts");
  });
});
