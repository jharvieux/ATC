# Session state — last updated 2026-06-10 23:30 CT

## Standing rule (operator, 2026-06-10 — in auto-memory)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous. Two approvals were granted this session: #903 voice-table GRANTs, #908 RLS policy migration.

## Just completed (fable/Opus-tier session)
- **#908 CLOSED (PR #921, D-198).** Member-level conversation isolation: app guard on 4 routes (the live hole — escalate + persona-switch had NO ownership check), RLS rewrite applied to prod with approval, snapshots regenerated. Pivotal finding: tenantClient is service-role, RLS never ran on routes.
- **#904 SHIPPED pending merge (PR #922, D-199).** Draft composer: client-side .eml/.msg parsing (3 operator-approved deps), deterministic persona suggestion, [name]-placeholder greeting contract, fail-closed 100/day cap, draft-only pinned by test. Both Opus audits clean. Merge train running.
- Earlier today (D-197): #913/#906/#866/#903/#881 all merged; grants-fix #920; checkpoint #919.

## In flight
- **PR #922 (#904)** on the merge-train Monitor — merges itself when green.
- **This checkpoint PR** (D-198 + D-199 + this SESSION) — merge after #922 (doc-only).

## Next step
1. **Ask operator: manual atc-rag deploy** (prod action) so draft turns get RAG grounding — until then drafts work but ungrounded (graceful degrade, alert fires). `cd apps/rag && vercel deploy --prod --yes` per the reference memory.
2. Close out #902/#903/#904 issues if not auto-closed; BYO Phases 1–3 are now ALL shipped.
3. Remaining backlog: #890 (inbound persona replies — the future send-on-behalf on-ramp), #885 (Playwright lightbox), #857 (operator checklist), #851 (model resilience), #898 (dependabot), #869 (stale PR — close pending operator OK).

## Blocked on user
- atc-rag prod deploy approval (grounded drafts).
- #899 Vercel Hobby → Pro — blocks #894.
- PR #869 close approval.

## Open questions
- pr-audit-section-check vs update-branch friction: the merge-train pattern handles it, but a workflow tweak (treat merge-commit-only synchronize events as non-staling) would remove ~3 CI cycles per queued PR. Needs its own PR if wanted.
