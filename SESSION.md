# Session state — last updated 2026-05-27 ~05:00 UTC

## Just completed (overnight run)

Massive D-091 audit follow-up batch. ~19 PRs opened, most merged or
near-merging at session end.

### Merged into dev tonight
- **#265** safe-mutation wrapper (D-094) + atomic increment RPC for tenant_usage_metrics
- **#266** chat conversation history (D-095) — tenant_id filter + alternation guard after Greptile review
- **#267** error-injection probe foundation + Stripe/GitHub webhook coverage
- **#268** Haiku PII redact fails closed (D-091 R3 #44)
- **#270** CCPA export allowlist + multi-tenant purge fix (D-091 R3 #45/#46)
- **#271** migration(inngest): wrap unchecked mutations with safeAwait (46 files, ~70 sites)
- **#272** migration(api): wrap unchecked mutations with safeAwait (41 files, ~70 sites)
- **#273** migration(lib): wrap unchecked mutations with safeAwait (22 files, ~30 sites)
- **#274** spec addendum for D-091 hardening (specs/TechSpec/spec-addendum-d091-hardening.md)
- **#279** flip atc/no-unchecked-supabase-mutation from off → error (rule now lint-blocks all future regressions)

### Open PRs at session end (awaiting CI / sequential merge)
- **#275** refactor(inngest): extract Tier-1 cron bodies for testability
- **#276** instrumented call wrappers fail-closed on hard state (#56/#58)
- **#277** customer chat kill-switch BEFORE stream starts (#43)
- **#278** quote acceptance CAS guard (#49)
- **#280** quote price-lock expiry enforcement (#47)
- **#281** booking submit CAS lock + revert-on-failure (#50/#51) + migration adds 'submitting' enum value
- **#282** persist full PDF HTML on quote accept (#48)
- **#283** admin reconciliation audit-wrapper signature + Haiku prompt injection mitigation (#52/#53)

The merge train is sequential because each merge invalidates the next branch's CI status — every rebase triggers a fresh ~3-5 min CI cycle. The operator can complete the train in the morning by repeating rebase → push → wait → merge for each branch.

### Codemod shipped
- `scripts/codemod-safe-await.py` — used to mechanically wrap ~170 unchecked Supabase mutations across apps/main. Kept in-tree for future migrations.

### Spec addendum
- `specs/TechSpec/spec-addendum-d091-hardening.md` captures the architectural deltas: safeAwait wrapper, conversation-history helper, error-injection probe, 12 new doctrine bullets, 7 ESLint rules, section-by-section deltas, procedure changes.

## In flight (8 open PRs)

All 8 are mergeable; CI is rerunning across the merge train. The script for the loop:

```bash
git fetch origin
for br in refactor/extract-cron-handlers-v2 fix/call-wrapper-hard-state fix/chat-kill-switch-streaming fix/quote-accept-cas-guard fix/quote-price-lock-expiry-enforcement fix/bookings-host-submit-atomicity fix/quote-dispute-pdf-audit "fix/admin-reconciliation-#52-#53"; do
  git checkout $br && git rebase origin/dev && git push --force-with-lease
done
# Then merge each as CI greens.
```

## Next step

**A. Finish the merge train.** The 8 open PRs should merge in sequence once CI clears. The order doesn't matter (none conflict semantically), but each merge re-rebases the rest.

**B. Read every Greptile review** on #275–#283 before final merge per the D-093 procedure.

**C. Continuing work the operator may want:**
- Migrate apps/rag's ~42 unchecked-mutation sites. apps/rag/.eslintrc.json doesn't currently load eslint-plugin-atc; needs `"eslint-plugin-atc": "workspace:*"` in package.json, plugin loaded in eslintrc, rule added at `error`. Then codemod the sites.
- Help-AI assistant-turn persistence (deferred from #266). Within-help-AI multi-turn context is still single-turn pending the schema work (decide: should help-AI turns count toward chat metrics? what tenant scoping for admin-source sessions?).
- Error-injection probe expansion — Tier 2/3 handlers still need coverage. Tracked in `apps/main/test/error-injection/README.md`.
- Reconciliation cron for stuck 'submitting' bookings — sweep older than N min back to draft. Tracked in #281's PR body.

## Blocked on user

- Vercel env vars largely populated; some optional still empty (Resend FROM domain, GitHub App, OAuth Microsoft) — not blocking dev.
- Production deploy still requires cutting a `release/*` branch — not blocking.

## Open questions

- The merge-train pattern is slow (8 PRs × ~5 min CI each). Could be faster if branch-protection allowed `--auto` merges across stacked PRs.
- apps/rag migration: include a similar codemod step or by hand? 42 sites is small enough for either.
- Spec addendum locations: this PR put it at `specs/TechSpec/spec-addendum-d091-hardening.md` per direction. Future addendums may want a sibling pattern like `spec-addendum-DXXX-<topic>.md` so they form a discoverable series.

## Decisions logged tonight
- **D-094** (PR #265 + RPC follow-up): safe-mutation wrapper + atomic increment RPC. Codifies "every Supabase mutation must check `{ error }`" across the codebase.
- **D-095** (PR #266): conversation history helper. Two-layer tenant isolation restored after Greptile review. Alternation guard collapses consecutive same-role turns.
- **D-096** (this batch): per-handler structural fixes — quote CAS, booking CAS, Haiku prompt injection, audit wrapper signatures, kill switch placement, hard-state enforcement, CCPA fixes.

## Carried forward (deferred work, unchanged)

- BP39 follow-up: retroactive react-pdf wire-up
- BP31: Haiku tolerable-PII redaction confidence/clarity scorer (cost-deferred)
- BP30: AI behavior eval harness (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer
- §13.9 active vs reactive health probing — operator decision (currently reactive-only per D-087)
- §20.4 / §38.8 / §38.8.1 / §39.5 — customer-facing AI chat panels build (~2 days, browser testing)
