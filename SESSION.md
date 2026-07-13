# Session state — last updated 2026-07-13 ~14:00 UTC (issue-sweep #3 complete)

## Just completed
- **Third /issue-sweep**: 15 batches → **15 PRs merged** (#1872 #1874 #1878 #1879 #1880 #1881 #1884 #1886 #1889 #1890 #1891 #1892 #1894 #1897 + fix rounds), **14 issues closed** (#1854 #1844 #1856 #1862 #1860 #1855 #1866 #1865 #1863 #1680 #1875 #1565, plus #1871 dup and alert #100 path). Operator approvals recorded per-item in-session (supervised "all", migrations approved, concurrency 5).
- Highlights: P1 booking disclosure fail-closed end-to-end (#1878 + follow-ups #1876/#1882/#1883); atomic invitee-cap RPC supersedes the accepted race (#1894, D-351); CI exit-code masking family fixed + RAG suite finally wired into nightly (#1892); 3 migrations landed (unique-index dedup, 4 FK indexes, reserve RPC); #1855 proven a phantom — real GroupInviteView TZ bug fixed instead; GHAS-comment discipline added mid-sweep at operator request (D-352, #1896) and immediately caught 2 real items.
- Ops issues created from the morning list: #1868 (VERCEL_RAG_PROJECT_ID secret), #1869 (promote integration-tests-critical to required), #1870 (GitGuardian resolutions).
- Code-scanning: #100 fixed (PR #1897), #97–#99 dismissed with reasons, 101/102 fixed in #1890.
- MEMORY: D-350–D-352 prepended (this PR).

## In flight
- Nothing in flight — clean checkpoint once this docs PR merges. Sweep ledger deleted after.

## Next step
1. Operator: work the morning-list ops issues #1868 / #1869 / #1870 (all manual).
2. Watch the FIRST nightly run with the RAG suite active (#1892): schema-drift risk tracked in #1893 (no migration-push step for the RAG test DB yet).
3. Prod apply of the three new migrations is operator-gated (runbook §6): 20260722000020/21/22 merged to dev but not applied to prod.

## Blocked on user
- #1868/#1869/#1870 (ops, manual).
- Decision issues still open: #1888 (feedback_* admin writer or DB-edit-only), #1812 convention canon (destructure-before-return vs #1791 style — comment on issue), #1858 deferred until real payments, #1805 deferred.
- Remaining supervised/dedicated-session backlog unchanged: #1585 #1523 #1623 #1740 #1247 #1358 #1728 #1724 #1782(210-index audit remainder).

## Open questions
- #1470 stays open pending proof the nightly actually executes the RAG suite post-#1892 (then close).
- #1887 gates #1826's closure (SYNC_ELIGIBLE_KEYS expansion; source_revision guard note recorded on the issue).
- #1896: GHAS-comment runbook change + unused-GitHub-features audit (merge queue would replace the manual update-branch merge train — biggest win).
