# Audit gaps — scan-coverage triage decisions (#1621)

Triage of the scan-coverage gap catalog from the external code-audit venture (`jharvieux/Harvey` — `docs/design/scan-coverage-gaps.md`), evaluated against ATC's actual guard/CI suite rather than the generic "vibe-coded app" baseline the catalog was written for. Each candidate below was verified against the live repo and, where possible, the live Supabase project config — not assumed from the catalog description.

This is a decision record, not new tooling. Where the decision is "add a check," the concrete ask is filed as its own tracked issue (linked below) per CLAUDE.md's "every deferral gets an issue" rule.

## Decision table

| # | Gap class | Decision | Evidence | Follow-up |
|---|---|---|---|---|
| 1 | Supabase project-config auditing (auth drift, storage buckets, dangerous extensions) | **Add a check** | Live `get_advisors(security)` pull during this triage found a real, currently-open WARN on `atc-main`: `auth_leaked_password_protection` disabled. Also 13/8 `rls_enabled_no_policy` INFO findings (main/rag) and 3 `authenticated_security_definer_function_executable` WARNs on main, and an `extension_in_public` (`vector`) WARN on rag — none currently asserted on in CI. | #1635 |
| 2a | Supply-chain: typosquat / hallucinated dependency names | **Accepted risk, no action** | Dependencies arrive via reviewed Dependabot PRs + the existing `dependency-ignore-watch` process (`docs/runbooks/dependency-ignore-watch.md`) — a human sees every new package name before merge. Lower urgency than for an unreviewed vibe-coded pipeline. | — |
| 2b | Supply-chain: postinstall/lifecycle-script policy (Shai-Hulud class) | **Add a check** | No `.npmrc` `ignore-scripts` setting and no lockfile lifecycle-script diff check exists. A reviewer approving a routine version-bump PR is unlikely to notice a newly-introduced `postinstall` script in a transitive dep — the current human-review process doesn't catch this sub-class even though it catches 2a. | #1636 |
| 3 | LLM-feature hardening (prompt injection, LLM-output-to-HTML XSS, LLM-driven SQL/shell) | **Already covered — no action.** Corrects a premise in #1621: `check:ai-purpose` is not the relevant control (it only checks `AICallPurpose` enum parity against a DB CHECK constraint — unrelated to injection/XSS). | Verified directly: (a) indirect prompt injection from scraped/RAG content is screened by `apps/main/src/lib/external/cruisemapper/prompt-injection-screen.ts` (BP36 §33.5/§26.8) with a dedicated pinned test suite (`test/unit/security/anti-prompt-injection.test.ts`, `test/unit/external-cruisemapper/prompt-injection-screen.test.ts`) plus delimiter-wrapped addenda in `lib/personas/build-system-prompt.ts`. (b) All 6 `dangerouslySetInnerHTML` sinks in the codebase were traced to tenant-authored email templates / help-doc markdown / tenant branding CSS — none are fed by chat/LLM output. Chat assistant text renders via `renderMessageContent.tsx`, which places model output as React text nodes (auto-escaped), not `dangerouslySetInnerHTML`. (c) No `exec`/`execSync`/`child_process` usage found in `lib/ai` or `api/chat` — no tool-call path builds shell/SQL from model output. | — |
| 4a | Secret-scan refinement: `.next` bundle scan for embedded `service_role` JWT | **Deferred, low priority** | No such scan exists today; also not urgent — would need JWT-decode (not shape-match) to avoid false positives on the anon key. | #1637 |
| 4b | Secret-scan refinement: `NEXT_PUBLIC_.*(KEY\|SECRET\|TOKEN\|SERVICE)` naming lint | **Deferred, low priority** | Verified grep-clean today — no `NEXT_PUBLIC_` var with a secret-shaped name exists in `apps/main/src` or `apps/rag/src`. Pure defense-in-depth against a future mistake. | #1637 |
| 4c | CORS wildcard guard | **Already covered — close, no action** | Confirmed exactly one place in the codebase sets `Access-Control-Allow-Origin` (`apps/main/src/lib/http/cors.ts`); it's a centralized, documented, Bearer-token-only (no `credentials: include`) wildcard for the browser-extension/iOS-Shortcut clients. No route sets its own CORS headers. | — |
| 4d | Leftover debug/test API routes | **N/A today — close, no action** | Confirmed via `find` — no `/api/debug`, `/api/dev`, or `/api/test*` route exists anywhere under `apps/main/src/app/api`. Bundled into #1637 as a stretch item if that issue is picked up, since it's the same low-priority "presence guard" shape. | #1637 (bundled) |

## Needs an operator decision (not a code/CI question)

Item 1's live finding — **leaked password protection is currently disabled on the `atc-main` Supabase Auth config** — is a dashboard toggle, not a code change. Per CLAUDE.md, prod-config changes need explicit per-instance operator approval rather than an agent flipping it silently. Flagged here and in #1635; needs the user's call on whether/when to enable it.

## Sources

- Original catalog: `jharvieux/Harvey` — `docs/design/scan-coverage-gaps.md`, `docs/design/mechanical-toolchain.md`.
- Triage issue: #1621.
- Verification performed 2026-07-06 against `dev` HEAD (`694e1407`) and live `atc-main` / `atc-rag` Supabase projects via `get_advisors`.
