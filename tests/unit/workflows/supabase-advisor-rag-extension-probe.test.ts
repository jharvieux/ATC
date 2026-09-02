import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WORKFLOW = resolve(__dirname, "../../../.github/workflows/supabase-advisor-check.yml");

function workflowSource(): string {
  return readFileSync(WORKFLOW, "utf8");
}

describe("Supabase advisor RAG extension probe workflow", () => {
  it("keeps advisor scans and explicit probes on mutually exclusive event gates", () => {
    const source = workflowSource();

    expect(source).toContain("rag_extension_probe_revision:");
    expect(source).toContain("rag_extension_probe_project_ref:");
    expect(source).toContain("required: false");
    expect(source).toContain(
      "if: github.event_name == 'schedule' || inputs.rag_extension_probe_revision == ''",
    );
    expect(source).toContain(
      "if: github.event_name == 'workflow_dispatch' && inputs.rag_extension_probe_revision != '' && inputs.rag_extension_probe_project_ref != ''",
    );
    expect(source).toContain("group: shared-test-db");
    expect(source).toContain("contents: read");
  });

  it("binds the secret-backed probe to one exact full lowercase revision", () => {
    const source = workflowSource();

    expect(source).toContain("PROBE_ACTUAL_REVISION: ${{ github.sha }}");
    expect(source).toContain(
      "PROBE_ALLOWED_PROJECT_REF: ${{ inputs.rag_extension_probe_project_ref }}",
    );
    expect(source).toContain("PROBE_DB_URL: ${{ secrets.SUPABASE_RAG_TEST_DB_URL }}");
    expect(source).toContain(
      "PROBE_EXPECTED_REVISION: ${{ inputs.rag_extension_probe_revision }}",
    );
    expect(source).toContain("ref: ${{ inputs.rag_extension_probe_revision }}");
    expect(source).toContain('[[ ! "$PROBE_EXPECTED_REVISION" =~ ^[0-9a-f]{40}$ ]]');
    expect(source).toContain('[[ ! "$PROBE_ALLOWED_PROJECT_REF" =~ ^[a-z0-9]{20}$ ]]');
    expect(source).toContain('checked_out_revision="$(git rev-parse HEAD)"');
    expect(source).toContain('[[ "$checked_out_revision" != "$PROBE_EXPECTED_REVISION" ]]');
    expect(source).toContain('[[ "$PROBE_ACTUAL_REVISION" != "$PROBE_EXPECTED_REVISION" ]]');
    expect(source).toContain("run: pnpm tsx scripts/probe-rag-extension-relocation.ts");
  });

  it("does not persist probe evidence or expose the database URL", () => {
    const source = workflowSource();

    expect(source).not.toContain("actions/upload-artifact");
    expect(source).not.toMatch(/run:.*PROBE_DB_URL/);
    expect(source.match(/SUPABASE_RAG_TEST_DB_URL/g)).toHaveLength(1);
  });
});
