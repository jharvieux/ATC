# Audit modules — the full deliverable

> **Positioning vs. deliverable.** Market on the **wedge** (multi-tenant security depth — what's
> underserved and gets the meeting). Deliver the **breadth** below (a complete codebase-health audit —
> what makes the engagement worth $X, sticky, and expands who'll buy). Do **not** market as "generic code
> quality" — that's the commoditized lane (SonarQube/Code Climate). Security leads; the rest is the value.

A full audit is 7 modules. Each lists what it finds, the method, the tool/skill that powers it, whether it's
**net-new build** or **existing tooling to wire in**, and what it contributes to the report.

| # | Module | Powered by | Status |
|---|--------|-----------|--------|
| M1 | Multi-tenant security (lead) | `scan-extras.txt` + `/vuln-scan` + `/triage` | exists (Tier-1 briefs done) |
| M2 | Local penetration test (dynamic) | local stack + probe scripts; later the Tier-2 pipeline | **net-new** (#1503 dynamic half) |
| M3 | Hotspot analysis | git churn × complexity | **net-new** |
| M4 | Duplication | jscpd | exists (`pnpm check:duplication`) |
| M5 | Slop / dead code | slop-check + D-091 + dead-export detection | exists, wire in |
| M6 | Simplification / reuse / maintainability | `/simplify` + pre-pr-reviewer doctrine + `quality-extras.txt` | exists, wire in |
| M7 | Performance tuning | Supabase perf advisors + profiling + bundle/Web-Vitals tools | **net-new** to assemble |
| M8 | Test quality & intent | StrykerJS mutation testing + tests-for-intent review | **net-new** |

---

## M1 — Multi-tenant security (the differentiator)
- **Finds:** cross-tenant data exposure (permissive/missing RLS), service-role bypass, single-layer isolation,
  per-route auth gaps, webhook replay, fail-open enforcement, unchecked mutations, RMW counter races,
  idempotency ordering, in-memory rate limits, SSRF-via-URL, state-machine boundary, error disclosure.
- **Method:** static review (the brief) + outcome-based confirmation for the Critical class.
- **Powered by:** `scan-extras.txt` + `fp-rules.txt` via `/vuln-scan --extra` / `/triage --fp-rules`.
- **Report:** §3 Findings, ranked by blast radius. This is the headline.

## M2 — Local penetration test (dynamic)
- **Finds:** what static review can't *prove* — actually reachable cross-tenant access, IDOR on API routes,
  missing-auth endpoints, auth/role escalation, rate-limit bypass across instances, injection that lands.
- **Method:** stand up the target locally (or a throwaway staging) with a **seeded two-tenant dataset**;
  run probes as (a) anon key, (b) tenant-A user, (c) tenant-B user — assert nobody crosses tenants; hit
  every API route with missing/forged auth; attempt the limiter bypass. Turns a static "looks exploitable"
  into a demonstrated "here's the row from the other tenant."
- **Status:** **net-new.** A guided/semi-automated dynamic pass now; later automated by the Tier-2
  outcome-based detector (#1503). Tracked separately (see issues).
- **Report:** dynamic confirmations attached to M1 findings (a proven finding is worth 10× a theoretical one),
  plus any dynamic-only findings.

## M3 — Hotspot analysis
- **Finds:** the files that are **both** frequently changed **and** complex — where bugs and maintenance cost
  concentrate. Tells the client *where to spend remediation budget*.
- **Method:** `git log` churn (commit count / lines changed per file over N months) × a complexity signal
  (cyclomatic complexity or LOC) → rank. Cross-reference against M1/M5/M6 findings (a hotspot that's also a
  security finding is the top priority).
- **Status:** **net-new** (git churn script + a complexity tool, e.g. a TS complexity analyzer).
- **Report:** a hotspot table (file · churn · complexity · overlapping findings) + a "fix these first" callout.

## M4 — Duplication
- **Finds:** copy-paste clones — a bug-multiplier and maintenance tax (fix once, miss the other three copies).
- **Method:** jscpd across the source tree; report % duplication and the worst clusters.
- **Powered by:** existing `pnpm check:duplication` (jscpd) — point it at the client repo.
- **Report:** duplication summary + top clone clusters with consolidation suggestions.

## M5 — Slop / dead code
- **Finds:** AI-generated cruft and dead weight — narrating comments, single-use helpers, try/catch that just
  re-throws, orphan TODOs, unused exports, unreachable branches, stub-shaped code (params that don't affect output).
- **Method:** slop-check diff scanner + the D-091 anti-pattern catalog + dead-export detection.
- **Powered by:** existing slop-check + pre-pr-reviewer doctrine — generalized to a whole-repo pass.
- **Report:** a cleanup list (delete/inline/simplify), grouped, with rough line-count reduction.

## M6 — Simplification / reuse / maintainability ("don't reinvent the wheel")
- **Finds:** the supportability tax — hand-rolled implementations of things a stdlib/framework primitive or a
  well-known library already does; over-abstraction (abstractions for single use); inconsistent patterns that
  raise the bus-factor; complexity a senior engineer would call overcomplicated.
- **Method:** the `/simplify` skill + the pre-pr-reviewer "surgical-changes / reuse / would-a-senior-call-this-
  overcomplicated" doctrine, generalized to a whole-repo pass, plus the `quality-extras.txt` brief.
- **Powered by:** `/simplify` + `quality-extras.txt`.
- **Report:** maintainability recommendations — each "reinvented wheel" with the suggested
  library/primitive to replace it, and the over-abstractions to collapse. This is the "lower your ongoing
  maintenance + onboarding cost" pitch, which lands even with clients who don't think they have a security problem.

## M7 — Performance tuning
- **Finds:** the slow paths and the cost they impose — N+1 / unindexed foreign-key queries, missing or unused
  indexes, RLS policies re-evaluated per row (bare `auth.*` not wrapped in a subquery), over-fetching / missing
  pagination, missing caching, oversized client bundles, poor Core Web Vitals, inefficient hot-loop algorithms.
- **Method:** static (query-pattern review, missing-index detection, bundle analysis) + dynamic (slow-query
  logs, profiling, Lighthouse/Web-Vitals on the running app). For Supabase specifically, the **performance
  advisor** (`get_advisors` performance) surfaces unindexed FKs, unused indexes, and `auth_rls_initplan`
  directly — then verify fixes against a test DB before recommending.
- **Status:** **net-new** to assemble (advisor pull + bundle/Web-Vitals tooling + a profiling pass). Tooling
  mostly exists; the build is the harness around it.
- **Report:** §3b Performance table (finding · layer · impact · fix · effort), ranked by user-facing impact.
- **Proof point:** this very dimension is demonstrated in the source repo — unindexed FKs → covering indexes,
  and `auth.uid()` → `(select auth.uid())` RLS initplan fixes, both advisor-surfaced and test-DB-verified.

## M8 — Test quality & intent
- **Finds:** tests that **can't fail when the logic changes** — the false-confidence layer. Tautological/snapshot-only
  tests, tests that assert WHAT not WHY, high *line coverage* masking low *mutation* coverage, and the specific code
  paths with no effective test (surviving mutants). Directly operationalizes the house rule "a test that can't fail
  when business logic changes is wrong."
- **Method:** two facets. (1) **Mutation scan** — run **StrykerJS** (or the stack's mutation tester): it injects
  faults (flip `>` to `>=`, negate conditionals, swap return values, delete statements) and reports the **mutation
  score** = % of mutants the suite kills. Surviving mutants are the blind spots, located precisely. (2)
  **Tests-for-intent review** — read the high-value tests (auth, tenant isolation, payments, state machines) and flag
  the ones that would still pass if the behavior they "cover" were broken.
- **Status:** **net-new.** Stryker needs a working test runner + a time budget (mutation runs are slow — scope to the
  critical modules, not the whole repo). Pair the score with the qualitative read for the report.
- **Report:** mutation score overall + per critical module; a "tests covering X can't actually fail" list (the
  dangerous ones — e.g. a tenant-isolation test that passes even with RLS removed); and which surviving mutants sit
  on a security/perf hotspot (cross-reference M1/M3). The pitch: *your coverage number is lying to you, here's where.*

---

## How the modules compose into one engagement
1. Threat-model (focus areas) → 2. M1 static security scan → 3. M3 hotspots + M4 dup + M5 slop + M6 maintainability
+ M7 performance + M8 test quality (can run in parallel; scope Stryker to critical modules) → 4. M2 local pen test to
**prove** the high-severity M1 findings → 5. assemble into the ranked report (`audit-report-skeleton.md`),
cross-referencing hotspots and surviving mutants against findings → 6. remediation plan + retest offer.

**Packaging:** offer a **Security audit** (M1+M2, the wedge, lower price/faster) and a **Full codebase audit**
(M1–M8, higher price, the upsell). Lead the pitch with the security depth; show the full report as the reason to buy the bigger package.
