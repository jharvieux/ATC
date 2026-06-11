# Session state — last updated 2026-06-11 13:50 UTC

## Standing rule (operator, permanent)
**No prod DB changes or manual prod deploys without per-instance operator approval.** Dev-merge pipeline stays autonomous.
**Note (D-205):** there is currently ONE Supabase project (mfaknjyqiwcjojukcnea) serving production — MCP applies ARE prod applies. Gate accordingly until #386/#534 split environments.

## Just completed
- Tenant branding applied at runtime (§16.2) on branch `claude/tenant-branding-ui-1piloz` (D-209):
  - New `lib/branding/tenant-theme.ts` (hex→HSL, WCAG contrast, font sanitize, CSS builder) + `TenantTheme` injector + `BrandLogo` + request-memoized `getRequestTenantBranding`
  - Injected on (tenant) layout, root page (shell + landing), agents pages, group coordinator layout, /q/[token], /companion/[token]
  - Tenant logo in SiteHeader + TenantShell; tenant name/favicon via generateMetadata
  - §16.2 contrast warnings in settings/branding form (non-blocking)
  - `pnpm verify` green; `next build` compiles + typechecks (prerender stops at /legal/ai-disclaimer missing Supabase env — same failure on clean base, pre-existing)
- Opened issue #1008: remaining unbranded customer surfaces (app/settings/*, groups invitation views, tokenized-page favicon/title)

## In flight
- Branch `claude/tenant-branding-ui-1piloz` pushed; NO PR opened (remote session — user didn't request one). When a PR is wanted: open into dev, run d091-reviewer + pre-pr-reviewer (diff is 18 files / ~640 added lines → first audit run on Opus per CLAUDE.md size trigger), fill `## Audit`, reference #1008 in "Not in scope".

## Next step
- User decision: open the PR for `claude/tenant-branding-ui-1piloz` into dev (then audit agents + merge), or review the branch first.

## Blocked on user
- Whether to open/merge the tenant-branding PR.

## Open questions
- #1003: D-201 narrowing — reviewer scope and mechanism review (user chose to defer)
- PRs #993/#994/#995 still open; user said "merge everything later"
- #1008: theming sweep for remaining customer surfaces (deferred from this branch)
