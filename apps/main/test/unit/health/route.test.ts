// #542 — /api/health must report the commit it's actually running. Vercel
// populates VERCEL_GIT_COMMIT_SHA (build + serverless runtime); it does NOT set
// GIT_COMMIT_SHA, so the original handler — which read GIT_COMMIT_SHA alone —
// reported commit:"unknown" on every prod response, making the endpoint useless
// for "which build is live?" observability. These tests pin the precedence so a
// refactor can't silently drop the VERCEL_GIT_COMMIT_SHA read and reintroduce
// the always-"unknown" regression.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET } from "@/app/api/health/route";

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = process.env;
  process.env = { ...originalEnv };
  delete process.env["VERCEL_GIT_COMMIT_SHA"];
  delete process.env["GIT_COMMIT_SHA"];
});

afterEach(() => {
  process.env = originalEnv;
});

async function commit(): Promise<unknown> {
  const body = (await GET().json()) as { commit: unknown };
  return body.commit;
}

describe("/api/health commit reporting (#542)", () => {
  it("reports VERCEL_GIT_COMMIT_SHA — the var Vercel actually populates", async () => {
    process.env["VERCEL_GIT_COMMIT_SHA"] = "vercel-sha";
    expect(await commit()).toBe("vercel-sha");
  });

  it("prefers VERCEL_GIT_COMMIT_SHA over GIT_COMMIT_SHA when both are set", async () => {
    process.env["VERCEL_GIT_COMMIT_SHA"] = "vercel-sha";
    process.env["GIT_COMMIT_SHA"] = "git-sha";
    expect(await commit()).toBe("vercel-sha");
  });

  it("falls back to GIT_COMMIT_SHA when VERCEL_GIT_COMMIT_SHA is unset", async () => {
    process.env["GIT_COMMIT_SHA"] = "git-sha";
    expect(await commit()).toBe("git-sha");
  });

  it("falls back to \"unknown\" when neither is set", async () => {
    expect(await commit()).toBe("unknown");
  });

  it("returns the static health shape", async () => {
    const body = (await GET().json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("main");
  });
});
