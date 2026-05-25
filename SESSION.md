# Session state — last updated 2026-05-25 ~02:20 UTC

## Overnight outcome — 7 draft PRs covering BP34–BP40

Every framing BP is on a branch with a draft PR open. All typecheck clean. 137 new unit tests across the suite (+ 83 pre-existing import tests on PR #133). 11 new migrations.

| PR | Branch | BP | Highlights |
|----|--------|----|-----------|
| [#133](https://github.com/jharvieux/ATC/pull/133) | `feature/bp34-phase-a-schema` | **BP34 A+B+C+D** | Inbound import end-to-end backend + review queue UI; tech-spec addenda checked in |
| [#134](https://github.com/jharvieux/ATC/pull/134) | `feature/bp35-referral-attribution` | **BP35** | First/conversion-touch + rolling 10-touch + UTM middleware |
| [#135](https://github.com/jharvieux/ATC/pull/135) | `feature/bp36-source-of-business-reporting` | **BP36** | attribution_rollup MV + nightly refresh + 6 reports + cancel-category. **Stacked on #134** |
| [#136](https://github.com/jharvieux/ATC/pull/136) | `feature/bp37-tasks-and-follow-up` | **BP37** | Tasks + sequence engine with snapshot + reminder cron + 4 default sequences |
| [#137](https://github.com/jharvieux/ATC/pull/137) | `feature/bp38-multi-option-quote-builder` | **BP38** | quote_options + 3 expand-migrate-contract migrations + line-item validation |
| [#138](https://github.com/jharvieux/ATC/pull/138) | `feature/bp39-client-facing-deliverables` | **BP39** | Trip itinerary + resources page; **@react-pdf/renderer installed** per D-079 |
| [#139](https://github.com/jharvieux/ATC/pull/139) | `feature/bp40-non-cruise-line-items` | **BP40** | booking_line_items + per-type validation + Components bulk view |

## Merge order recommendation

1. **#133 (BP34)** first — the largest, and the tech-spec addenda commits in it unblock subsequent specs being readable from `dev`. Mark ready-for-review when you've decided on Phase D (Gmail OAuth + UI) split.
2. **#134 (BP35)** — independent of #133.
3. **#135 (BP36)** — must come after #134 (uses BP35's columns); rebase off `dev` once #134 lands.
4. **#136 / #137 / #139 / #140** in any order — all independent.

## In flight

Nothing in flight on a working branch. Currently on `chore/session-state-overnight-batch` for SESSION.md updates.

## Next step

Wait for user direction on the morning questions below. No autonomous work to continue from here — all framing BPs are queued; remaining work depends on user input (Phase D split, OAuth setup, etc.).

## Morning questions (all batched)

**Q1 — PR opening cadence.** All 7 PRs are draft. Convert all to ready-for-review now, or stage by BP? Recommend: convert #133 (BP34) first after you've reviewed; convert others as you're ready.

**Q2 — BP34 Phase D split.** Phase D backlog from #133:
- Review queue UI ✅ (already shipped in #133)
- Gmail OAuth connect/callback endpoints — needs your GCP project setup (still 501 stubs)
- 7-day Pub/Sub watch renewal cron
- Disconnect endpoint
- PDF OCR for document path (currently returns null → parse_failed)

Build as one follow-up PR or separate? Recommend separate: one for Gmail-OAuth chain, one for PDF OCR.

**Q3 — Gmail OAuth setup timing.** Pub/Sub webhook is live in #133 (uses fetch + jose, no SDK dep). When are you running `docs/runbooks/gmail-inbound-setup.md` to provision the GCP project + OAuth client + Pub/Sub topic? That unblocks Q2's Gmail follow-up PR.

**Q4 — PDF OCR dependency.** BP34 document-upload path needs OCR to extract text from uploaded PDFs. Three options:
- (A) `pdf-parse` npm — text-only PDFs; lightweight; would work for ~80% of forwarded confirmations
- (B) `pdfjs-dist` + OCR worker — handles scanned PDFs; heavier
- (C) Google Document AI / AWS Textract — costs $$$; defer until volume justifies
- Recommend (A) for v1. Need your approval for the new runtime dep.

**Q5 — BP35 wire-ups still pending.** Library + middleware + 3 identification points (contact create, quote create, booking submit) are wired in #134. NOT wired yet:
- Chat-start identification (depends on chat-start endpoint scaffolding)
- Form-submission identification (depends on form scaffolding)
- BP34 import-acceptance → `source_origin='imported'` touch (will wire when #133 merges and the import promoter is on dev)

Defer all three to a "BP35 wire-ups follow-up" PR or land separately? Recommend the latter.

**Q6 — BP36 CSV export.** Spec §36.8 calls for CSV export of every report. Backend complete, export wrapper is mechanical. Sync (<10k rows) + async (Inngest) split mentioned in spec. Want CSV export in #135 (would add ~150 LOC + tests), or as a follow-up PR?

**Q7 — BP37 system task generators.** Five daily Inngest crons referenced in §37.5 (passport expiring, final payment, quote expiring, post-trip, lead aging). Not in #136. Each is ~80 LOC + tests; 400 LOC total for a "BP37 Phase B" PR. Want them as a single follow-up PR or interleave with other priorities?

**Q8 — Email reminder channel for BP37.** Library exposes email channel; reminder fire-up cron currently marks email reminders as 'delivered' without actually sending. Wire-up to BP23 sendTemplatedEmail is mechanical (~50 LOC). Land as a tiny PR or fold into #136?

**Q9 — BP38 customer-facing tokenized URL.** `/api/quote-options/:id/select` currently requires agent permission. The "customer clicks Select on the tokenized quote page" flow needs a parallel customer-token endpoint. Was deferred. Want it as a BP38 follow-up?

**Q10 — BP39 + BP40 itinerary integration.** §40.6 says non-cruise line items should interleave into §39's day-by-day. The renderer in #138 doesn't yet pull from `booking_line_items`. Land as a tiny BP39+BP40 integration PR once both merge?

**Q11 — UI gaps.** The following UI work is deferred across BPs:
- BP34 — review queue UI ✅ (in #133)
- BP35 — manual source picker on contact create UI
- BP36 — Reports dashboard pages (6 pages + filters + chart components)
- BP37 — "My Tasks" + per-record task lists + sequence management
- BP38 — quote builder (side-by-side multi-option form)
- BP39 — agent edit pages for itinerary + resources
- BP40 — line-items table on booking detail + Components bulk view

Prioritization? My recommendation: BP36 reports + BP37 My Tasks have highest agent-facing impact; BP38 quote builder + BP39 agent edit are essential to making those features usable end-to-end.

## Blocked on user

Nothing strictly blocking next-task selection — every BP shipped is internally complete to its declared scope. Items above are all "want vs need" for the next round.

## Carried forward from earlier sessions

- BP31: Haiku tolerable-PII redaction + confidence/clarity scorer Haiku call (cost-deferred)
- BP30: AI behavior eval harness, continuous-sampling cron, dedicated test Supabase project, Percy/Chromatic (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer
- Help-docs PDF retro to @react-pdf/renderer (now installed via #138 — per D-079)
