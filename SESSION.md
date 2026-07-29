# Session state — last updated 2026-07-29 13:05 CT

## Just completed
- **PR #2057 merged** (squash, `6a982a70`) — SEO/AEO foundation. D-368 logged.
  - `/robots.txt`, `/sitemap.xml`, `/llms.txt` as host-aware route handlers. Production served **no** robots.txt or sitemap.xml before this (both 404).
  - Only `PLATFORM_PRIMARY_DOMAIN` is indexable. Tenant subdomains and Agency custom domains get `X-Robots-Tag: noindex, nofollow` (set in a `proxy()` wrapper, not at its ~12 return points), `Disallow: /`, and a 404 sitemap.
  - All AI crawlers explicitly allowed, each group carrying the same `DISALLOWED_PATHS` as the wildcard.
  - Root layout metadata overhaul + generated OG image; per-page metadata on agents/quiz/legal; `noindex, follow` on `/signup` and `/chat`.
  - Organization + WebSite + SoftwareApplication (3 Offers) + FAQPage JSON-LD. `Offer` prices share `PUBLIC_TIERS` with the rendered pricing table so they cannot drift.
  - FAQ grown 7 → 15 agent-facing questions.
  - **`/` is now the agency landing page**; `/for-agencies` 308s to it; traveller surface moved to `/travelers`.
  - Fixed inline: `/for-agencies` and both legal pages had zero inbound internal links anywhere on the site.
- Issue **#2058** filed — per-tenant search-indexing opt-in for Agency-tier custom domains (deferred by operator choice).
- Four audit rounds on #2057; final verdict clean from both agents.
- **PR #2060 merged** — disambiguated the FAQ spec citation in `AgencyLanding.tsx` (see Blocked-on-user item 2).

## In flight
- Nothing in flight — clean checkpoint. On `dev`, synced with origin. `.codex/` and `AGENTS.md` remain untracked working-tree files (unchanged, not committed).

## Next step
- Nothing queued. Natural follow-ons if resumed: #2058 (custom-domain indexing opt-in), or verifying `https://ai-travelconcierge.com/sitemap.xml` serves 200 after the next prod release.

## Blocked on user
1. **ROTATE `MTC-COM-9V5ZKDJC5TI0`** (memtrace license key, `.codex/config.toml`). A `git add -A` swept the untracked `.codex/` dir and `AGENTS.md` into commit `c10e53ce` and pushed it before the D-091 audit caught it. The branch was rebuilt so no merged commit contains it, but the key reached GitHub and that SHA may remain fetchable. Treat as exposed. Also consider whether `.codex/` should be gitignored.
2. ~~`// FAQ order per spec §9` citation~~ — **RESOLVED, PR #2060 merged.** It was never a TechSpec reference. The FAQ derives from `docs/marketing/byo-agency-landing.html`; the `§N` markers are the component's own numbering from #685. The comment now attributes each of the first seven entries individually (setup compresses that doc's "Live in an afternoon" section; cost appears nowhere in it; the other five come from its FAQ in order, two merged into one). Took four revisions — `pre-pr-reviewer` caught three successive overclaims, all real. **Lesson: when asked why code says something, read the source before explaining it. Every wrong revision was a plausible-sounding inference.**
3. **Submit the sitemap** to Google Search Console and Bing Webmaster Tools once `6a982a70` reaches production. Without submission, discovery is slow.
4. Carried from prior session: old Stripe account webhook endpoint still needs disabling; prod release including `bba75c0e` (crons dead in prod until then); #1740 prod DDL repair; atc-rag manual prod deploy; extension smoke test; #2025 time-boxed check.
5. Carried: ~18 stale worktrees + ~95 stale remote sweep branches await deletion sign-off.

## Open questions
- Agency-tier **custom domains** are currently `noindex` alongside subdomains. An agency on its own domain may reasonably want it indexed — that's #2058, and the operator declined building the switch this round.
- The homepage change is a real product shift: anonymous visitors to the root domain now see the agency sales page rather than the consumer hero. Worth confirming that matches intent once it's visible in production.
- Carried: portable `/issue-sweep` drift (lives outside version control); post-release cron verification in Vercel logs; alert #103 CodeQL verification.
