# GitHub features audit — adopt / reject decisions pending (#1896 Part 2)

**Status: proposal only. No feature listed here has been enabled by this doc's author. Every section ends with an explicit operator-decision marker — nothing here is a done deal until the operator picks an option.**

Facts below were pulled live from the repo on 2026-07-13 via `gh api repos/jharvieux/ATC` and `.github/workflows/`. Repo is `jharvieux/ATC`, public, owned by a user account (not an org), default branch `dev`.

---

## 1. Merge queue

**Current state:** Not configured. `gh api repos/jharvieux/ATC/rulesets` returns `[]` (no rulesets of any kind exist), and `dev`'s branch protection is classic (`branches/dev/protection`), which does not include a merge-queue block. All merging today is the manual sequential "merge PR A → update-branch PR B → merge B" train described in `docs/runbooks/pr-workflow.md`'s Merge trains section.

**What adopting looks like here:** GitHub's merge queue needs either (a) a repository ruleset targeting `dev` with "Require merge queue" turned on, or (b) the newer classic-protection checkbox for the same (I'm not fully certain which paths are available to a public repo on this account's plan — would need to check in the GitHub UI before committing to a path). Once enabled, PRs get queued and GitHub speculatively merges each PR against the *predicted* post-queue state of `dev`, running CI on that speculative merge before actually updating `dev`.

**The test-DB ledger interaction (the analysis #1896 specifically asked for):** This repo's migration workflow (`docs/runbooks/migrations.md`) treats the shared test DB as a ledger — migrations apply in the order they land on `dev`, and CI assumes the DB state matches whatever `dev` looks like at the moment a given PR's CI runs. A merge queue's speculative-merge model runs CI against a *temporary, GitHub-computed* merge commit that is NOT what lands on `dev` if an earlier queued PR is dequeued (e.g. its own speculative check fails, or it's manually pulled). If two queued PRs both add migrations, the queue could run PR B's CI against a speculative merge that includes PR A's migration, all while PR A's migration file has already run once against the literal shared test DB and left it mutated. A merge queue does not re-run `pnpm verify` against a byte-identical DB state on every entry the way the current strict, one-PR-at-a-time train does. This is a real correctness risk for this repo's specific migration-ledger design, not a generic caveat — it would need either (a) restricting the merge queue to non-migration PRs only (hard to enforce automatically), or (b) a from-scratch test-DB reset per queue entry (cost/latency), before it's safe to turn on.

**Recommendation:** Do not adopt yet. The workflow-orchestration win (no more manual update-branch sequencing) is real and matches what #1671 already identified as wasteful, but the migration-ledger hazard above needs a concrete mitigation design first — this shouldn't be a same-PR toggle.

**Operator decision required:** adopt (needs a follow-up design spike for the migration-ledger interaction) / reject (keep the manual train) / defer.

---

## 2. Auto-merge (`gh pr merge --auto`)

**Current state:** Already enabled at the repo level — `gh api repos/jharvieux/ATC -q .allow_auto_merge` returns `true`. It is already in active use for exactly one flow: `.github/workflows/dependabot-automerge.yml` calls `gh pr merge --auto --squash` for managed Dependabot minor/patch groups. It is NOT used for Claude-authored or human PRs into `dev` — those are merged manually by the agent/operator per `pr-workflow.md`'s ordered flow (verify → push → PR → audit agents → gate rerun → merge).

**What adopting more broadly looks like here:** Calling `gh pr merge --auto` right after opening a PR (instead of manually squash-merging once green) would let GitHub merge the moment required checks pass, with no supervisor loop. The complication #1896 names is real: the `pr-audit-section-check` gate doesn't go green until the audit-agent marker comments post (comments don't retrigger the check — it needs an explicit `gh run rerun`, per `pr-workflow.md`). If auto-merge is enabled before that rerun, the PR sits waiting on a red/pending gate indefinitely (harmless) but the operator loses the natural "everything's green, merge now" checkpoint where a human/agent double-checks the audit reports were clean before the merge fires.

**Recommendation:** Adopt narrowly for Dependabot (already done, no change needed). For agent/human PRs, hold off — the current manual gate-rerun-then-merge step is also where GHAS-comment disposition (this issue's Part 1) and audit-report review happen; auto-merge would need to be sequenced to fire only after those, which today only a human/agent judgment call gets right.

**Operator decision required:** adopt for agent-authored PRs too (with the sequencing caveat above) / reject / already correctly scoped as-is.

---

## 3. Secret scanning push protection

**Current state — verified via `gh api repos/jharvieux/ATC -q .security_and_analysis`:**

```json
{
  "secret_scanning": { "status": "enabled" },
  "secret_scanning_push_protection": { "status": "enabled" },
  "dependabot_security_updates": { "status": "enabled" },
  "secret_scanning_non_provider_patterns": { "status": "disabled" },
  "secret_scanning_validity_checks": { "status": "disabled" }
}
```

Push protection **is already on** — this is not a gap. Two related sub-features are off: `secret_scanning_non_provider_patterns` (detects generic-looking secrets, not just known-vendor formats) and `secret_scanning_validity_checks` (pings the provider to confirm a leaked-looking token is actually still live, which cuts false-positive noise).

**What adopting the two off sub-features looks like:** Both are single-checkbox repo settings (`Settings → Code security → Secret scanning`), no code or workflow change.

**Recommendation:** Push protection itself needs no action (already correct). Turning on `secret_scanning_validity_checks` is low-risk and directly reduces the "verify before alarm" manual work `docs/runbooks/triage.md` already asks for on every secret-scanning alert. `secret_scanning_non_provider_patterns` trades more false positives for broader coverage — worth it only if there's evidence of home-grown secret formats slipping through.

**Operator decision required:** enable `secret_scanning_validity_checks` (recommended, low cost) / enable `secret_scanning_non_provider_patterns` too / leave both as-is.

---

## 4. Dependency review action

**Current state:** Not present. `grep -rl "dependency-review" .github/workflows/` returns nothing. Dependabot alerts (post-merge) and the existing `dependabot-regression-detector.yml` / `dependency-ignore-watch.yml` workflows are the only automated dependency-risk coverage today — both are post-merge or scheduled, not PR-time gates.

**What adopting looks like here:** Add a small workflow step using `actions/dependency-review-action` on `pull_request` targeting `dev`, configured to fail the check on new dependencies at or above a chosen severity (e.g. `high`) introduced by the PR's lockfile diff. It would need to be added to the CI required-checks list in branch protection to actually block a merge, and reviewed against the `paths-ignore` pattern the other workflows use so it doesn't run needlessly on doc-only PRs.

**Recommendation:** Adopt — this is the one item in the list with an unambiguous, low-effort win: it closes the exact gap the issue calls out (Dependabot alerts are post-merge; this is pre-merge) and the action is GitHub-maintained with no infra cost. Low blast radius since it's advisory-only unless made a required check.

**Operator decision required:** adopt as a required check / adopt as advisory-only (report but don't block) / reject.

---

## 5. Rulesets vs classic branch protection

**Current state — verified:**
- `gh api repos/jharvieux/ATC/rulesets` → `[]`. No repository rulesets exist at all.
- `dev` uses **classic branch protection** (`branches/dev/protection`): required status checks (`Typecheck`, `Lint`, `Test`, `Secret Scan`, `CVE Scan`, `RLS Snapshot Diff`, `Cross-Tenant Probe`, `Contract Tests`, `pr-audit-section-check`, `Guards & Build`) with `strict: true`, `require_code_owner_reviews: true`, `enforce_admins: true`, force-pushes and deletions disabled.
- **`main` has NO GitHub-enforced protection at all** — `gh api repos/jharvieux/ATC/branches/main/protection` returns `404 Branch not protected`. CLAUDE.md's "never commit directly to main" rule is currently enforced entirely by agent/operator discipline, not by GitHub. This is worth flagging even though it's adjacent to the literal "rulesets vs classic" question: the biggest exposure isn't classic-vs-ruleset on `dev`, it's that `main` has zero native enforcement of any kind.

**What adopting rulesets looks like here:** Rulesets add org-level reuse (moot for a single-owner repo), a bypass list with an audit trail (classic protection's `enforce_admins` is binary — no bypass audit trail), and are the only path to some newer features (e.g. merge queue, per GitHub's current rollout — see item 1's uncertainty note). Migrating `dev` from classic to a ruleset is a like-for-like config port, not a behavior change, unless new ruleset-only rules are added at the same time.

**Recommendation:** Two separable asks. (a) Protect `main` at the GitHub level — even a minimal ruleset/classic rule blocking direct pushes would convert a documented-only rule into an enforced one, and costs nothing since only the pipeline pushes there anyway. (b) Migrating `dev` from classic to rulesets is optional churn unless the operator wants the bypass audit trail or plans to adopt merge queue.

**Operator decision required:** add GitHub-level protection to `main` (recommended, currently a real gap) / migrate `dev` to rulesets / leave both as-is.

---

## 6. CODEOWNERS

**Current state:** **Already exists** — `.github/CODEOWNERS`, all entries owned by `@jharvieux`:

```
/.github/workflows/    @jharvieux
/.github/CODEOWNERS    @jharvieux
/scripts/staging-fixups.sql @jharvieux
/apps/main/src/lib/env.ts @jharvieux
/apps/rag/src/lib/env.ts @jharvieux
/apps/main/.env.example @jharvieux
/apps/rag/.env.example @jharvieux
/docs/runbooks/secret-rotation.md @jharvieux
/docs/runbooks/stripe-price-ids.md @jharvieux
```

The issue's checklist asked "currently absent?" — it is not; this line item can be closed as already-in-use. `dev`'s branch protection has `require_code_owner_reviews: true`, so these paths already gate on the (single) code owner's review.

**What adopting more broadly looks like here:** Since there's one human operator and one owner, broader CODEOWNERS coverage wouldn't add a second reviewer — it would just widen which PRs require the operator's explicit review click before merge (currently only the listed sensitive paths do). That's a real trade-off against the "agent has full autonomy to merge" model CLAUDE.md establishes elsewhere.

**Recommendation:** No action — current scope (workflows, secrets-adjacent env files, staging SQL, rotation docs) already covers the highest-risk paths. Expanding it further would work against the autonomous-merge model without adding a second reviewer.

**Operator decision required:** confirm current scope is correct / add more paths (name them) / no change.

---

## 7. Copilot / GHAS autofix for code scanning

**Current state:** Not verifiable as configured via the REST fields checked (`security_and_analysis` has no autofix field for public repos — GHAS features are free on public repos and don't surface an `advanced_security` toggle the way they would on a private repo). `gh api repos/jharvieux/ATC/code-scanning/default-setup` reports `"state": "not-configured"`, but that's the *default setup* (GitHub-managed CodeQL config) — this repo uses its own advanced workflow (`.github/workflows/codeql.yml`) instead, which is why default setup shows unconfigured; that's expected, not a gap. Copilot Autofix specifically is a per-organization/Copilot-license feature and isn't something I can confirm on/off from the API surface available here — **I don't know its current state and am not guessing.**

**What adopting looks like here:** Autofix would auto-suggest a fix commit on new code-scanning alerts opened by the custom CodeQL workflow (it works with advanced/custom workflows, not just default setup). It complements, not replaces, the manual GHAS-comment disposition step this issue's Part 1 just added.

**Recommendation:** Worth checking directly in `Settings → Code security → Code scanning → Copilot Autofix` since it can't be confirmed from here — flagging as an open verification task rather than a recommendation either way.

**Operator decision required:** check current on/off state in the UI, then decide adopt / reject.

---

## 8. Deployment environments / protection rules

**Current state — verified via `gh api repos/jharvieux/ATC/environments`:** 8 environments exist: `dev`, `Preview`, `Preview – atc-main`, `Preview – atc-rag`, `production`, `Production – atc-main`, `Production – atc-rag`, `staging`. Only two carry a protection rule: `production` and `Production – atc-main`, both with `required_reviewers` naming `jharvieux` (the operator) as sole required reviewer.

Cross-checking against what `.github/workflows/deploy.yml` actually references (`grep -n "environment:"`) narrows this a lot: **only two environment names are used by any workflow job** — `staging` (the `deploy-staging` job, release branches) and `production` (the combined prod job). Per that job's own comment (deploy.yml, near the `Vercel deploy (atc-rag production)` step), **atc-rag's production deploy runs through this same job and the same `production` environment gate as atc-main** — "one approval covers both." So atc-rag prod deploys ARE already gated by the operator's required-reviewer approval; I was wrong to assume otherwise before checking the workflow file, and I'm flagging that correction explicitly rather than leaving a guess in an audit doc.

The remaining five environments (`dev`, `Preview`, `Preview – atc-main`, `Preview – atc-rag`, `Production – atc-main`, `Production – atc-rag`) are **not referenced by any `.github/workflows/*.yml` job**. These carry the exact naming pattern Vercel's native Git-integration app auto-creates per linked project (one "Preview" + one "Production" environment per Vercel project) — consistent with atc-main's deploys being handled by Vercel's native integration rather than an explicit Actions step. I have not independently confirmed this against the Vercel dashboard in this session, so I'm stating it as a strong inference, not a verified fact: **these five environments most likely have no enforcement role at all** — they're deployment-history bookkeeping created by Vercel, not gates GitHub Actions checks against.

**What adopting more looks like here:** There's no real gap to close on the two environments that matter (`staging`, `production`) — both are wired into the one workflow that deploys through them, and `production` already has the reviewer gate. If the five Vercel-created environments are confirmed unused for enforcement, there's nothing to configure there either.

**Recommendation:** No action needed on the enforcement side — the important environment (`production`) already gates both apps' prod deploys through one approval. Worth a quick manual check (Vercel dashboard → Git integration settings) to confirm the five unused-by-workflows environments really are just Vercel bookkeeping and not a stale leftover from an earlier config, but that's a five-minute verification, not a change.

**Operator decision required:** none on enforcement (already correctly gated) / optionally verify the five unreferenced environments are inert Vercel bookkeeping, not a stale config to clean up.

---

## 9. Issue forms / templates

**Current state:** Absent. No `.github/ISSUE_TEMPLATE/` directory, no `.github/ISSUE_TEMPLATE.md`, no `.github/PULL_REQUEST_TEMPLATE.md`.

**What adopting looks like here:** A YAML issue form (`.github/ISSUE_TEMPLATE/*.yml`) could bake in the fields this repo's own conventions already require by hand — acceptance criteria, "what's the bug / where does it live / what's the likely fix" (per CLAUDE.md's "never ignore a bug" section), and a model-tier field mirroring `triage.md`'s haiku/sonnet/opus labeling convention. Sweeps and agent-opened issues (bugs, follow-ups, #1896 itself) currently free-form this structure per CLAUDE.md's own acceptance-bar language.

**Recommendation:** Adopt — low effort, directly matches an already-documented convention (the issue acceptance-bar text in CLAUDE.md), and would reduce the chance of an agent-opened issue skipping a required field (this exact repo's rules already demand "what/where/why/likely-fix" — a form makes that structural instead of a checklist an agent has to remember).

**Operator decision required:** adopt (recommended) / reject / adopt but let the operator draft the form fields.

---

## 10. Artifact attestations / provenance

**Current state:** Not present. No workflow references `attest`, `provenance`, or the `actions/attest-build-provenance` action. `deploy.yml` (the production pipeline) does not currently produce a signed provenance attestation for its build artifacts.

**What adopting looks like here:** Add an `actions/attest-build-provenance` step to `deploy.yml` after the build step, which would let anyone verify a deployed artifact was built by this exact workflow run from this exact commit, via `gh attestation verify`. This is meaningful protection against a compromised build step or a supply-chain tampering scenario between build and deploy.

**Recommendation:** Lower priority than the other items — both apps deploy via the Vercel CLI (`vercel deploy`) inside `deploy.yml`'s jobs, not via a `actions/upload-artifact`-and-download pattern, so there's no discrete GitHub Actions build artifact for `actions/attest-build-provenance` to attach to in the standard way. Worth a closer look at what `deploy.yml` actually builds/uploads before deciding this is applicable at all.

**Operator decision required:** investigate whether `deploy.yml`'s artifact model is even attestation-shaped before deciding / reject as not-applicable / adopt if applicable.

---

## 11. Scheduled CodeQL

**Current state — verified, already in place.** `.github/workflows/codeql.yml` has all three triggers already: `push` (branches `dev`, `main`), `pull_request` (branch `dev`, with a `paths-ignore` for doc-only PRs), **and** `schedule: cron: '0 6 * * 1'` (weekly, Monday 06:00 UTC), plus manual `workflow_dispatch`. The in-repo comment explicitly notes the weekly schedule exists to "catch new GitHub-maintained rules" and to cover doc-only PRs that skip the `pull_request` trigger. This item is already correctly configured — no gap.

**Recommendation:** No action needed.

**Operator decision required:** none — confirmed already correct, included here only because #1896 asked for it to be verified.

---

## Summary table

| # | Feature | Current state | Recommendation | Operator decision needed |
|---|---|---|---|---|
| 1 | Merge queue | Not configured | Hold — migration-ledger risk needs a design first | adopt (needs spike) / reject / defer |
| 2 | Auto-merge | **Already on**, used for Dependabot only | Keep scoped to Dependabot; hold for agent PRs | adopt broader / reject / keep as-is |
| 3 | Secret scanning push protection | **Already enabled** | Turn on `validity_checks` too | enable extras / leave as-is |
| 4 | Dependency review action | Not present | Adopt | required check / advisory-only / reject |
| 5 | Rulesets vs classic | Classic on `dev`; **`main` has zero GitHub protection** | Protect `main` first; ruleset migration optional | protect main / migrate to rulesets / leave as-is |
| 6 | CODEOWNERS | **Already exists**, scoped to sensitive paths | No action | confirm scope / expand / no change |
| 7 | Copilot/GHAS autofix | Unknown — not visible via API | Check UI directly | check then decide |
| 8 | Deployment environments | 8 exist; only `staging`+`production` are referenced by workflows; atc-rag prod already shares `production`'s reviewer gate | No action — already correctly gated | none / optionally verify unused envs are inert |
| 9 | Issue forms | Absent | Adopt | adopt / reject / operator drafts fields |
| 10 | Artifact attestations | Absent | Unclear applicability given Vercel deploy model | investigate / reject / adopt if applicable |
| 11 | Scheduled CodeQL | **Already correct** (weekly + push + PR) | No action | none |

Five of the eleven items turned out to already be in place or already correct (auto-merge, secret scanning push protection, CODEOWNERS, deployment environments, scheduled CodeQL) — the issue's framing ("features we're not using or ignoring") was partly answered by "already using, just undocumented." This doc is that documentation. Two items surfaced real gaps worth prioritizing: **`main` has no GitHub-level branch protection at all** (item 5), and the dependency-review action would close the one clean pre-merge dependency-risk gap (item 4).
