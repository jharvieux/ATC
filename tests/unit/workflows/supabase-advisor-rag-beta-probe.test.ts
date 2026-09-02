import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(__dirname, "../../../.github/workflows/supabase-advisor-check.yml"),
  "utf8",
);

describe("RAG beta exact-revision deployment probe", () => {
  it("keeps the advisor scan and beta probe mutually exclusive", () => {
    expect(source).toContain("rag_beta_probe_revision:");
    expect(source).toContain(
      "if: github.event_name == 'schedule' || inputs.rag_beta_probe_revision == ''",
    );
    expect(source).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.rag_beta_probe_revision != ''",
    );
  });

  it("deploys one fail-closed revision through the configured RAG project root", () => {
    expect(source).toContain("PROBE_EXPECTED_REVISION: ${{ inputs.rag_beta_probe_revision }}");
    expect(source).toContain("VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}");
    expect(source).toContain("VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}");
    expect(source).toContain("VERCEL_PROJECT_ID: ${{ secrets.VERCEL_RAG_PROJECT_ID }}");
    expect(source).toContain("ref: ${{ inputs.rag_beta_probe_revision }}");
    expect(source).toContain('[[ "$(git rev-parse HEAD)" != "$PROBE_EXPECTED_REVISION" ]]');
    expect(source).toContain('vercel project inspect --token="$VERCEL_TOKEN" --yes');
    expect(source).toContain(
      'vercel deploy --token="$VERCEL_TOKEN" --yes 2>&1 | tee /tmp/vercel-deploy.log',
    );
    expect(source).toContain('vercel inspect "$beta_url" --logs --token="$VERCEL_TOKEN"');
    expect(source).not.toContain("working-directory: apps/rag");
    expect(source).not.toContain("--cwd apps/rag");
    expect(source).not.toContain("--prod");
  });
});
