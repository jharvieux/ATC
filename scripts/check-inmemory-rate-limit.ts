// In-memory rate-limit guard (epic #1393 / G4; Day-1 scan F-tok-01 / F-rag-wh-01).
//
// A rate/quota limiter backed by a module-level `new Map()` / `new Set()` is
// PER-INSTANCE: under Fluid Compute the limit is enforced independently in each
// warm function instance and reset on every cold start, so an attacker spreading
// requests across instances (or simply hammering until a new instance spins up)
// trivially exceeds it. Public/anon-reachable limiters MUST be backed by a shared
// store — Redis (`@/lib/redis/client` → `incr`/`expire`) or a DB-atomic counter —
// like `apps/rag/src/lib/rate-limit/feedback-limit.ts`.
//
// Detection: a MODULE-LEVEL (column-0) `const|let|var <name> … = new Map(` /
// `new Set(` whose <name> carries a limiter token (rate / limit / throttle /
// attempt / bucket / quota / hits). That name heuristic is what separates a
// limiter store from the many legitimate in-process CACHES (slugCache,
// personaCache, breaker, …) which are fine per-instance. Pre-existing limiters
// are frozen in the baseline; the gate fails on NEW occurrences only.
//
// Text/name pattern check (not type analysis). Accepted-risk per-instance
// limiters (e.g. a low-concurrency flow with a separate per-identity cap) belong
// in the baseline with a tracking issue, OR carry an inline
// `inmem-ratelimit-allow:<reason>` on or directly above the declaration.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_FILE = path.join(ROOT, "scripts/inmemory-rate-limit-baseline.txt");
const SCAN_DIRS = ["apps/main/src", "apps/rag/src"];

// Column-0 declaration of a Map/Set whose variable name reads like a limiter
// store. `^(?!\s)` anchors to module scope — an in-function cache is indented and
// would not survive across requests anyway, so it isn't the bug we hunt.
const LIMITER_DECL_RE =
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_]*(?:rate|limit|throttle|attempt|bucket|quota|hits)[A-Za-z0-9_]*)\b[^=]*=\s*new\s+(?:Map|Set)\b/i;

export interface RateLimitHit {
  key: string; // <relpath>::<varName>
  varName: string;
  line: number;
}

function isInlineAllowed(lines: string[], idx: number): boolean {
  const token = "inmem-ratelimit-allow:";
  if ((lines[idx] ?? "").includes(token)) return true;
  for (let j = idx - 1; j >= 0; j -= 1) {
    const prev = lines[j] ?? "";
    if (prev.trim() === "") continue;
    return prev.includes(token);
  }
  return false;
}

export function findInMemoryLimiters(rel: string, content: string): RateLimitHit[] {
  const out: RateLimitHit[] = [];
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) return; // skip comments
    const m = LIMITER_DECL_RE.exec(line);
    if (!m) return;
    if (isInlineAllowed(lines, i)) return;
    const varName = m[1]!;
    out.push({ key: `${rel}::${varName}`, varName, line: i + 1 });
  });
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function loadBaseline(): Set<string> {
  if (!fs.existsSync(BASELINE_FILE)) return new Set();
  return new Set(
    fs
      .readFileSync(BASELINE_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}

function main(): void {
  const baseline = loadBaseline();
  const hits: RateLimitHit[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(ROOT, dir);
    // Fail-closed: a missing expected dir means we'd silently skip its files.
    if (!fs.existsSync(abs)) {
      console.error(`In-memory rate-limit check: expected scan dir missing: ${dir}. Run from repo root.`);
      process.exit(1);
    }
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file);
      hits.push(...findInMemoryLimiters(rel, fs.readFileSync(file, "utf8")));
    }
  }

  if (process.argv.includes("--update-baseline")) {
    const header =
      "# In-memory rate-limit guard baseline (#1393/G4). One <relpath>::<varName> per line.\n" +
      "# These are pre-existing per-instance limiters; the gate fails on NEW ones.\n" +
      "# Regenerate: pnpm check:rate-limit-store --update-baseline. Prefer a Redis/DB-backed\n" +
      "# limiter (see apps/rag/src/lib/rate-limit/feedback-limit.ts) over growing this list.\n";
    const body = hits
      .map((h) => h.key)
      .sort()
      .join("\n");
    fs.writeFileSync(BASELINE_FILE, `${header}${body}\n`);
    console.log(`Wrote ${hits.length} baseline entr(ies) to ${path.relative(ROOT, BASELINE_FILE)}.`);
    return;
  }

  const fresh = hits.filter((h) => !baseline.has(h.key));
  if (fresh.length > 0) {
    console.error("In-memory rate-limit violations — public/anon limiters must use a shared store (Redis/DB), not a module-level Map/Set:\n");
    for (const h of fresh) console.error(`  ${h.key.replace("::", " : ")} (line ${h.line})`);
    console.error(
      "\nUse a Redis-backed limiter (incr/expire via @/lib/redis/client — see " +
        "apps/rag/src/lib/rate-limit/feedback-limit.ts) or a DB-atomic counter. " +
        "If this is an accepted-risk per-instance limiter, add an inline " +
        "`inmem-ratelimit-allow:<reason>` or baseline it with a tracking issue.",
    );
    process.exit(1);
  }

  console.log(
    `In-memory rate-limit check passed: ${hits.length} grandfathered per-instance limiter(s) baselined, 0 new.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
