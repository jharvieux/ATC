// #1393/G4 — unit tests for the in-memory rate-limit guard's matcher.
//
// Pins WHY the guard exists: a module-level Map/Set used as a rate limiter is
// per-instance and trivially bypassed, so it must be flagged — but the many
// legitimate in-process CACHES (which share the same `new Map()` shape) must
// NOT be, or the guard is too noisy to keep. The split is the variable name.

import { describe, it, expect } from "vitest";
import { findInMemoryLimiters } from "../../../scripts/check-inmemory-rate-limit";

const J = (...l: string[]) => l.join("\n");

describe("findInMemoryLimiters", () => {
  it("flags a module-level rate limiter backed by a Map", () => {
    const hits = findInMemoryLimiters("apps/main/src/app/api/public/chat/[token]/route.ts", `const rateMap: Map<string, number[]> = new Map();`);
    expect(hits.map((h) => h.varName)).toEqual(["rateMap"]);
    expect(hits[0]?.key).toBe("apps/main/src/app/api/public/chat/[token]/route.ts::rateMap");
  });

  it("flags an attempt-counter Map (the OTP-IP limiter shape)", () => {
    expect(findInMemoryLimiters("r.ts", `const ipAttempts = new Map<string, IpEntry>();`).map((h) => h.varName)).toEqual(["ipAttempts"]);
  });

  it("flags a Set-backed limiter too", () => {
    expect(findInMemoryLimiters("r.ts", `const throttleSet = new Set<string>();`).map((h) => h.varName)).toEqual(["throttleSet"]);
  });

  it("does NOT flag a legitimate in-process cache (non-limiter name)", () => {
    expect(findInMemoryLimiters("r.ts", J(`const slugCache = new Map<string, CacheEntry>();`, `const personaCache = new Map();`, `const breaker = new Map<string, number>();`))).toEqual([]);
  });

  it("does NOT flag an indented (in-function, non-module) Map", () => {
    expect(findInMemoryLimiters("r.ts", `  const rateMap = new Map();`)).toEqual([]);
  });

  it("does NOT flag a commented-out declaration", () => {
    expect(findInMemoryLimiters("r.ts", `// const rateMap = new Map(); // old per-instance limiter, removed`)).toEqual([]);
  });

  it("honors the inline escape hatch for an accepted-risk per-instance limiter", () => {
    const src = J(`// inmem-ratelimit-allow: single-instance cron, no cross-instance contention`, `const rateBucket = new Map<string, number>();`);
    expect(findInMemoryLimiters("r.ts", src)).toEqual([]);
  });

  it("matches an exported limiter declaration", () => {
    expect(findInMemoryLimiters("r.ts", `export const requestRateLimitMap = new Map();`).map((h) => h.varName)).toEqual(["requestRateLimitMap"]);
  });
});
