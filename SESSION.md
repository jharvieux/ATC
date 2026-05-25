# Session state — last updated 2026-05-25 ~03:30 UTC

## ⚠️ Morning reminder

**Q3 from prior batch — Gmail GCP setup runbook (`docs/runbooks/gmail-inbound-setup.md`)**. You asked me to remind you.
The Gmail OAuth code is shipped (PR #142) but stays dormant until you provision the GCP project + OAuth client + Pub/Sub topic and set the env vars: `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REDIRECT_URI`, `GMAIL_PUBSUB_TOPIC`, `APP_OAUTH_STATE_SECRET`, `PLATFORM_APP_URL`.

## What's open

**19 PRs.** All ready-for-review. Stacks indicated.

### Feature PRs (ready-for-review)
| PR | Branch | Scope |
|----|--------|-------|
| [#133](https://github.com/jharvieux/ATC/pull/133) | `feature/bp34-phase-a-schema` | BP34 A+B+C+D backend |
| [#134](https://github.com/jharvieux/ATC/pull/134) | `feature/bp35-referral-attribution` | BP35 |
| [#135](https://github.com/jharvieux/ATC/pull/135) | `feature/bp36-source-of-business-reporting` | BP36 + CSV export (Q6 folded) |
| [#136](https://github.com/jharvieux/ATC/pull/136) | `feature/bp37-tasks-and-follow-up` | BP37 + email reminder channel (Q8 folded) |
| [#137](https://github.com/jharvieux/ATC/pull/137) | `feature/bp38-multi-option-quote-builder` | BP38 + customer-side tokenized select (Q9 folded) |
| [#138](https://github.com/jharvieux/ATC/pull/138) | `feature/bp39-client-facing-deliverables` | BP39 + react-pdf |
| [#139](https://github.com/jharvieux/ATC/pull/139) | `feature/bp40-non-cruise-line-items` | BP40 |
| [#140](https://github.com/jharvieux/ATC/pull/140) | `chore/session-state-overnight-batch` | session docs |

### Follow-up PRs (stacked)
| PR | Base | Scope |
|----|------|-------|
| [#141](https://github.com/jharvieux/ATC/pull/141) | #133 | BP34 PDF OCR (Q2/Q4 — uses already-installed pdf-parse) |
| [#142](https://github.com/jharvieux/ATC/pull/142) | #133 | BP34 Gmail OAuth chain (Q2 — connect/callback/disconnect + watch renewal) |
| [#143](https://github.com/jharvieux/ATC/pull/143) | #136 | BP37 system task generators ×6 (Q7) |
| [#144](https://github.com/jharvieux/ATC/pull/144) | #134 | BP35 `bindContactOnIdentification` + transfer-finalize wire (Q5) |
| [#145](https://github.com/jharvieux/ATC/pull/145) | #138 | BP39+BP40 itinerary line-items integration (Q10) |

### UI PRs (stacked, Q11)
| PR | Base | Scope |
|----|------|-------|
| [#146](https://github.com/jharvieux/ATC/pull/146) | #135 | BP36 Reports dashboard (6 pages) |
| [#147](https://github.com/jharvieux/ATC/pull/147) | #136 | BP37 My Tasks + TaskListInline |
| [#148](https://github.com/jharvieux/ATC/pull/148) | #137 | BP38 multi-option quote builder editor |
| [#149](https://github.com/jharvieux/ATC/pull/149) | #138 | BP39 ItineraryEditor + ResourcesEditor components |
| [#150](https://github.com/jharvieux/ATC/pull/150) | #139 | BP40 LineItemsPanel + Components bulk view |
| [#151](https://github.com/jharvieux/ATC/pull/151) | #134 | BP35 contact-create form with source picker |

## Recommended merge order

1. **#133 (BP34)** — largest base; also contains §34–§40 tech-spec addenda
2. Then in parallel: #134 (BP35), #137 (BP38), #138 (BP39), #139 (BP40), #136 (BP37)
3. **#135 (BP36)** after #134 (stacked dependency)
4. Stacked follow-ups + UI auto-rebase as their bases land
5. **#140** (session docs) — last, after dev settles

## In flight

Nothing. All work shipped on its branch.

## Blocked on user

- **Q3 reminder above** — Gmail GCP runbook
- All other questions from the morning batch are answered + implemented

## Carried forward

- BP31: Haiku tolerable-PII redaction + confidence/clarity scorer (cost-deferred)
- BP30: AI behavior eval harness, continuous-sampling cron, dedicated test Supabase project, Percy/Chromatic (cost-deferred)
- BP25: PLATFORM_PEPPER offsite storage + DO-NOT-ROTATE doc
- BP24: populate `platform_settings.supervisor_slur_deny_list`
- BP23: populate `port_info_chunks` content for 17 ports
- BP16/17: counsel sign-off on ICA + AI Liability Disclaimer

## What's still deferred (post-merge follow-ups)

- BP34 import-acceptance → `source_origin='imported'` touch (needs #133 + #134 both on dev)
- BP36 async export pipeline for >10k rows (§36.8) — sync export ceiling at 10k is in
- BP37 AI-suggested tasks (depends on §11 memory work) + sequence CRUD UI
- BP38 customer-facing side-by-side display page (data model is the same; styling pass)
- BP39 customer-side AI chat panel (§39.5 — depends on §9/§11)
- BP39 RAG-driven port descriptions (§39.2.1 — depends on §33.5 RAG)
- BP39 resources public viewer (parallel to /i/[token])
- BP40 cancellation cascade UI prompt (§40.7)
- Anonymous-chat "drop your email mid-chat" identification (endpoint doesn't exist yet)
- Help-docs PDF retro to @react-pdf/renderer (per D-079 pre-approval)
