// §8.7a (#1609) — the pending_rag_sync retry cron + daily cleanup were retired
// when delivery moved to Inngest. This pins that:
//   1. No orphaned Vercel cron schedule for rag-sync-retry remains (an orphaned
//      schedule would 404 every 15 minutes against a deleted route).
//   2. The retired route/lib/cleanup files are gone.
//   3. The Inngest app registers the new rag-sync-deliver function and no longer
//      registers the pending_rag_sync cleanup cron.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, "../../.."); // apps/main

describe("rag-sync retry cron retirement (#1609)", () => {
  it("has no rag-sync-retry cron schedule in vercel.json", () => {
    const vercel = JSON.parse(readFileSync(join(APP_ROOT, "vercel.json"), "utf8")) as {
      crons?: Array<{ path: string }>;
    };
    const paths = (vercel.crons ?? []).map((c) => c.path);
    expect(paths).not.toContain("/api/cron/rag-sync-retry");
    expect(paths.some((p) => p.includes("rag-sync"))).toBe(false);
  });

  it("has deleted the retired route, cron lib, and cleanup function files", () => {
    expect(existsSync(join(APP_ROOT, "src/app/api/cron/rag-sync-retry/route.ts"))).toBe(false);
    expect(existsSync(join(APP_ROOT, "src/lib/cron/rag-sync-retry.ts"))).toBe(false);
    expect(existsSync(join(APP_ROOT, "src/inngest/rag-sync-retry.ts"))).toBe(false);
  });
});

describe("Inngest registration after the move (#1609)", () => {
  afterEach(() => vi.resetModules());

  it("registers rag-sync-deliver and no longer registers the pending_rag_sync cleanup", async () => {
    vi.resetModules();
    vi.doMock("inngest/next", () => ({
      serve: (config: { functions: Array<{ id: () => string }> }) => ({ GET: config, POST: config, PUT: config }),
    }));
    const route = await import("@/app/api/inngest/route");
    const config = route.GET as unknown as { functions: Array<{ id: () => string }> };
    const ids = config.functions.map((f) => f.id());
    expect(ids).toContain("rag-sync-deliver");
    expect(ids).not.toContain("pending-rag-sync-cleanup");
    vi.doUnmock("inngest/next");
  });
});
