import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as mainHealth } from "../../../apps/main/src/app/api/health/route";
import { GET as ragHealth } from "../../../apps/rag/src/app/api/health/route";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(root, "scripts/check-production-version.sh");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
const sha = "0123456789abcdef0123456789abcdef01234567";
const staleSha = "89abcdef0123456789abcdef0123456789abcdef";
const tempDirs: string[] = [];
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = process.env;
  process.env = { ...originalEnv };
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.GIT_COMMIT_SHA;
});

afterEach(() => {
  process.env = originalEnv;
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function runCheck(body: string, expectedSha = sha, service = "main", curlStatus = "0") {
  const commandDir = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-revision-bin-"));
  tempDirs.push(commandDir);
  fs.writeFileSync(
    path.join(commandDir, "curl"),
    "#!/usr/bin/env bash\nprintf '%s' \"$FAKE_CURL_BODY\"\nexit \"$FAKE_CURL_STATUS\"\n",
    { mode: 0o755 },
  );
  return spawnSync(
    "bash",
    [script, "https://host.example.test/api/health", expectedSha, service],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${commandDir}:${process.env.PATH ?? ""}`,
        FAKE_CURL_BODY: body,
        FAKE_CURL_STATUS: curlStatus,
      },
    },
  );
}

function health(service: "main" | "rag", commit = sha) {
  return JSON.stringify({
    status: "ok",
    service,
    commit,
    commitSource: "vercel",
  });
}

describe("hosted revision health contracts", () => {
  it.each([
    ["main", mainHealth],
    ["rag", ragHealth],
  ] as const)("reports authoritative and fallback commit sources for %s", async (service, getHealth) => {
    process.env.VERCEL_GIT_COMMIT_SHA = ` ${sha.toUpperCase()} `;
    process.env.GIT_COMMIT_SHA = staleSha;
    await expect(getHealth().json()).resolves.toEqual({
      status: "ok",
      service,
      commit: sha.toUpperCase(),
      commitSource: "vercel",
    });

    delete process.env.VERCEL_GIT_COMMIT_SHA;
    await expect(getHealth().json()).resolves.toEqual({
      status: "ok",
      service,
      commit: staleSha,
      commitSource: "git",
    });
  });

  it.each([
    ["main", mainHealth],
    ["rag", ragHealth],
  ] as const)("does not hide a malformed Vercel commit behind the fallback for %s", async (service, getHealth) => {
    process.env.VERCEL_GIT_COMMIT_SHA = " ";
    process.env.GIT_COMMIT_SHA = sha;
    await expect(getHealth().json()).resolves.toEqual({
      status: "ok",
      service,
      commit: "unknown",
      commitSource: "vercel",
    });
  });
});

describe("production hosted revision check", () => {
  it.each(["main", "rag"] as const)("accepts an exact authoritative %s revision", (service) => {
    const result = runCheck(health(service), sha.toUpperCase(), service);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it.each([
    ["missing commit", JSON.stringify({ status: "ok", service: "main", commitSource: "vercel" })],
    ["unknown commit", health("main", "unknown")],
    ["malformed commit", health("main", "hosted-sha")],
    ["stale commit", health("main", staleSha)],
    ["missing source", JSON.stringify({ status: "ok", service: "main", commit: sha })],
    ["fallback source", JSON.stringify({ status: "ok", service: "main", commit: sha, commitSource: "git" })],
    ["wrong service", health("rag")],
    ["unhealthy service", JSON.stringify({ status: "degraded", service: "main", commit: sha, commitSource: "vercel" })],
    ["malformed response", "not-json"],
  ])("fails closed for %s", (_name, body) => {
    expect(runCheck(body).status).not.toBe(0);
  });

  it("fails closed when the host is unreachable", () => {
    expect(runCheck("", sha, "main", "22").status).not.toBe(0);
  });

  it.each(["", "short-sha", `${sha}00`])("rejects malformed expected SHA %j", (expectedSha) => {
    expect(runCheck(health("main"), expectedSha).status).not.toBe(0);
  });
});

describe("deployment workflow hosted revision policy", () => {
  it("uses exact checks for release staging and main and RAG production", () => {
    expect(workflow.match(/bash scripts\/check-production-version\.sh/g)).toHaveLength(3);
    expect(workflow).toMatch(/staging\.ai-travelconcierge\.com\/api\/health[\s\\]+"\$GITHUB_SHA"[\s\\]+main/);
    expect(workflow).toMatch(/ai-travelconcierge\.com\/api\/health[\s\\]+"\$GITHUB_SHA"[\s\\]+main/);
    expect(workflow).toMatch(/rag\.ai-travelconcierge\.com\/api\/health[\s\\]+"\$GITHUB_SHA"[\s\\]+rag/);
    expect(workflow).toContain('if [ -z "$HEALTH_COMMIT" ] || [ "$HEALTH_COMMIT" = "unknown" ] || [ "$HEALTH_COMMIT" != "$GITHUB_SHA" ]');
  });

  it("documents PR, merge-queue, and dev application checks as shared-host observation", () => {
    expect(workflow).toContain("pull_request, merge_group, and dev-push");
    expect(workflow).toContain("reuse APP_STAGING_URL instead of creating per-event app");
    expect(workflow).toContain("reports that shared host's own commit");
    expect(workflow).toContain("whose hosted app revision was not verified");
  });
});
