import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const resetSource = fs.readFileSync(path.join(root, "scripts/ci-reset-test-db.ts"), "utf8");
const deployWorkflow = fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
const nightlyWorkflow = fs.readFileSync(path.join(root, ".github/workflows/nightly-full-test.yml"), "utf8");

describe("RAG test database reset", () => {
  it("removes relocated extensions only for a RAG reset before rebuilding public", () => {
    const ragBranch = resetSource.match(/if \(target === "rag"\) \{([\s\S]*?)\n    \}/)?.[0] ?? "";

    expect(ragBranch).toContain("DROP EXTENSION IF EXISTS vector CASCADE;");
    expect(ragBranch).toContain("DROP EXTENSION IF EXISTS pg_trgm CASCADE;");
    expect(resetSource.match(/DROP EXTENSION IF EXISTS/g)).toHaveLength(2);
    expect(resetSource.replace(ragBranch, "")).not.toContain("DROP EXTENSION IF EXISTS");
    expect(resetSource.indexOf(ragBranch)).toBeLessThan(resetSource.indexOf("DROP SCHEMA IF EXISTS public CASCADE;"));
  });

  it("selects the RAG cleanup path at every RAG reset call site", () => {
    expect(deployWorkflow).toContain("pnpm db:reset:ci -- --target=rag");
    expect(nightlyWorkflow).toContain("pnpm db:reset:ci -- --target=rag");
  });
});

describe("atc-rag Vercel deployment root", () => {
  it("uses the Vercel project's configured apps/rag root exactly once", () => {
    const betaJob = deployWorkflow.slice(
      deployWorkflow.indexOf("\n  deploy-rag-beta:"),
      deployWorkflow.indexOf("\n  db-copy:"),
    );
    const productionStep = deployWorkflow.slice(
      deployWorkflow.indexOf("      - name: Vercel deploy (atc-rag production)"),
      deployWorkflow.indexOf("      - name: Smoke test atc-rag production"),
    );

    expect(betaJob).toContain('VERCEL_PROJECT_ID: ${{ secrets.VERCEL_RAG_PROJECT_ID }}');
    expect(betaJob).toContain('vercel deploy --token="$VERCEL_TOKEN" --yes');
    expect(productionStep).toContain('VERCEL_PROJECT_ID: ${{ secrets.VERCEL_RAG_PROJECT_ID }}');
    expect(productionStep).toContain('vercel deploy --prod --yes --token="$VERCEL_TOKEN"');
    expect(betaJob).not.toContain("working-directory: apps/rag");
    expect(productionStep).not.toContain("working-directory: apps/rag");
  });
});
