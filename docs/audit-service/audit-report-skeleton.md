# Audit report skeleton (deliverable template)

> The product is the report. Ranked by **blast radius**, not by file. Each finding is reproducible,
> mapped to the D-091 taxonomy, and paired with a concrete fix. Keep the language plain enough for a
> founder to forward to a non-technical buyer's procurement team.

---

## 0. Cover & engagement terms

- Client, scope (repos/branches/commit SHA reviewed), dates, auditor.
- **Liability language (required):** point-in-time advisory; not a guarantee of completeness; not a
  substitute for a full penetration test; liability capped at fees paid. _(LLC + this paragraph = bounded risk.)_

## 1. Executive summary (1 page — the part the buyer reads)

- One-paragraph posture statement in plain English.
- Findings count by severity: **Critical / High / Medium / Low**.
- The single most important sentence: *can one tenant reach another tenant's data, yes/no, and how.*
- Severity table:

  | # | Title | Severity | Blast radius | Status |
  |---|-------|----------|--------------|--------|
  | 1 | Cross-tenant read via permissive RLS | Critical | All tenants' rows | Open |

## 2. Scope & methodology

- What was reviewed (auth flow, RLS policies, service-role code paths, webhooks, API routes, migrations).
- How: manual code review of tenant-isolation logic + the D-091 taxonomy pass + targeted dynamic checks.
- Explicitly state what was **not** in scope (infra, dependencies, social engineering, etc.).

## 3. Findings (ranked by blast radius)

Order strictly by severity. For each finding use this block:

> ### F-01 — {Title}
> - **Severity:** Critical | High | Medium | Low
> - **Taxonomy:** {D-091 pattern, e.g. "Two-layer tenant isolation" / "Service-role leakage"}
> - **Location:** `path/to/file.ts:LINE` (+ the policy/route/migration name)
> - **What it is:** plain-English description of the flaw.
> - **Blast radius:** what an attacker reaches (e.g. "every tenant's `bookings` rows with the public anon key").
> - **Evidence / repro:** the minimal query, request, or policy that demonstrates it (sanitized).
> - **Fix:** the concrete change (e.g. add a `tenant_id` predicate; move to `(select auth.uid())`; add a replay guard).
> - **References:** OWASP/CWE + any framework doc.

### Severity rubric (map your taxonomy to it)

| Severity | Definition | Your taxonomy examples |
|---|---|---|
| **Critical** | Cross-tenant data exposure or full DB access | Missing/permissive RLS (`auth.role()='authenticated'`), service-role credential leakage, anon key as master key |
| **High** | Auth bypass, privilege escalation, replayable state change | Per-route permission gap, webhook with no replay protection, fail-open enforcement, single-layer tenant isolation |
| **Medium** | Exploitable under conditions / integrity loss | Idempotency-after-dispatch ordering, read-modify-write counter races, CAS without row-count check, SSRF via unvalidated URL field |
| **Low** | Hardening / defense-in-depth | Missing rate-limit store, error-message schema disclosure, missing input bound |

## 4. Remediation plan

- Prioritized fix order (Critical → down), with rough effort per item.
- "Fix these 3 before your next enterprise demo" callout — the action the buyer actually needs.

## 5. Retest & ongoing coverage (the upsell)

- Offer: free/discounted **retest** of Critical/High fixes within N days (closes the loop, builds trust).
- Recurring options: per-release re-audit, or continuous PR-level coverage (the niche bot) — land-and-expand
  into the relationship the one-time audit opens.

## 6. Appendix

- Full file/route/policy inventory reviewed.
- Taxonomy reference (the generalized D-091 catalog) so the client sees the rigor behind the pass.

---

### Notes for running the audit

- Lead every engagement by answering the cross-tenant question first — it's the headline risk and the buyer's
  real fear. Everything else is supporting cast.
- Keep findings reproducible. A finding the client can't reproduce is a finding they won't pay attention to —
  and it's how you'd lose a dispute.
- The harness (D-091 guards + review agents) does the finding; your value is the verification, the ranking, and
  the plain-English translation a founder can act on.
