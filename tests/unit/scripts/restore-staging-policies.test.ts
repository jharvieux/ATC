import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const restoreSql = readFileSync(path.resolve(process.cwd(), "scripts/restore-staging-policies.sql"), "utf8");

describe("staging storage policy restore", () => {
  it("recreates help-docs tenant SELECT isolation after public schema refresh", () => {
    expect(restoreSql).toMatch(/DROP POLICY IF EXISTS help_docs_tenant_select ON storage\.objects/);
    expect(restoreSql).toMatch(
      /CREATE POLICY help_docs_tenant_select ON storage\.objects\s+FOR SELECT TO authenticated\s+USING \(\s+bucket_id = 'help-docs'\s+AND auth_user_in_tenant\(\s+\(regexp_match\(name, '\^tenant_\(\[0-9a-f-\]\+\)\/'\)\)\[1\]::uuid\s+\)\s+\)/,
    );
  });
});
