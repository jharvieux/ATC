# Build Prompt — Generate Tenant Admin Help Documentation (v1)

**Target:** Claude Code, working in the AI Travel Concierge monorepo.

**Source specs:**
- `AI_Travel_Concierge_Spec_v6_Full.docx` — primary source of truth for all feature behavior.
- `Self_Service_Help_Addendum_v1.docx` — specifies the doc set (§3.2) and storage path (§3.1).
- `MEMORY.md` — decision log; read before starting.

If any spec disagrees with this prompt, the spec wins. Flag the disagreement and stop for clarification.

---

## Model usage instructions — read first

**Use Claude Sonnet for this entire task.** No Opus needed — this is well-scoped writing work where Sonnet performs well at much lower cost.

If you find yourself stuck on a structural decision (e.g., how to split a topic across two docs vs. keep in one), stop and ask the user rather than escalating to Opus.

---

## What you're producing

12 Markdown files in `apps/main/content/help/` that document the tenant admin console. These files are the source content for:

1. The onscreen documentation viewer (rendered to HTML at `/admin/help`).
2. The PDF and .docx export bundles.
3. The platform-docs RAG scope ingested by the parallel "Populate Help Docs RAG" build prompt.

Treat them as production user-facing documentation, not internal notes. They will be read by real tenant admins.

---

## Pre-work — before you write any file

1. Read `Self_Service_Help_Addendum_v1.docx` §3.2 (the 12-file list) and §3.4 (RAG indexing).
2. Read MEMORY.md for any prior decisions.
3. For each of the 12 doc files, identify which sections of the v6 spec contain the authoritative behavior. Build a mapping table — produce this in chat before writing any file so the user can confirm coverage. Example shape:

   ```
   01-getting-started.md          → v6 §15 (onboarding), §17 (auth signup flow)
   02-tenant-settings.md          → v6 §16 (branding partial), §1.4 (resolution)
   03-branding.md                 → v6 §16 (full), §29.4 (DNS), §29.12 (custom domain runbook)
   ...
   ```

4. Identify any gaps — topics in the doc plan that the v6 spec does NOT cover well. Surface these in chat before writing; do not invent behavior to fill them.

**Do not start writing docs until the user confirms the coverage mapping.**

---

## File-by-file scope

Filenames are fixed (from addendum §3.2). Order is the order they appear in the doc viewer's nav.

| File | Topic | Primary v6 spec sources |
| --- | --- | --- |
| 01-getting-started.md | First-time setup, signup completion, initial configuration | §15 (Sub-Host Onboarding), §17 (Auth) |
| 02-tenant-settings.md | Business identity, contact info, time zone | §1.4, §16 |
| 03-branding.md | Logos, colors, custom domains | §16, §29.4, §29.12 |
| 04-personas.md | Configuring AI personas | §10 (Supervisor context), persona definitions wherever they appear |
| 05-crm.md | Contacts, relationships, pipeline | §12 |
| 06-quotes-and-bookings.md | Quote builder, booking submission | §13, §20 |
| 07-rag-content.md | Submitting content; review queue | §6, §22 |
| 08-usage-and-billing.md | Tier, usage, billing | §14, §27.11 |
| 09-team-and-permissions.md | Team members, role assignments | §26 |
| 10-customer-management.md | Customer accounts, memory, escalations | §10.3, §11 |
| 11-supervisor-and-quality.md | Supervisor findings, escalations | §10 |
| 12-troubleshooting.md | Common issues and diagnosis | Cross-cutting; see "Troubleshooting authoring" below |

If the v6 spec doesn't cover something a tenant admin would obviously need (e.g., "how to reset my password" is auth flow but not deeply specified), call it out in your coverage mapping rather than improvising.

---

## Authoring standards

### Audience
Tenant admins. They are small-business operators running an independent travel agency. Assume: comfortable with web apps, not necessarily technical, no patience for jargon. Write at the same level as a well-edited SaaS help center — Stripe, Linear, and Notion are good reference points.

### Voice
- Plain English. Active voice. Second person ("You can...") not third.
- No marketing language ("powerful," "seamless," "leverage"). Say what it does.
- Short paragraphs. Frequent headings. Lots of step-by-step ordered lists where the action is procedural.
- No emoji.
- When a feature has a non-obvious limit or trade-off, mention it inline rather than burying it.

### Structure for each doc
Every doc opens with:
- A one-sentence summary of what the doc covers.
- A bulleted "in this article" overview (3–6 items).

Then sections. Use H2 (`##`) for major sections, H3 (`###`) for subsections. Avoid H4 unless truly necessary.

Each doc closes with:
- A "Related articles" section linking to other docs in the set.
- A "Still stuck?" line pointing to the help flows ("Open a help chat from the top right of this page" or similar).

### Length
- Aim for 800–1,500 words per doc. Going significantly over suggests the doc should be split.
- 12-troubleshooting.md may run longer (up to ~2,500) because it's reference-style.

### Cross-references between docs
Use relative Markdown links: `[branding setup](./03-branding.md#custom-domains)`.

### Cross-references to the v6 spec
Do NOT reference the v6 spec in user-facing docs. The spec is internal. If you find yourself wanting to say "per §16.3 of the spec," rewrite to describe the behavior directly.

### Screenshots and images
Do NOT generate or reference image files in v1. The file structure should support images (`![Add logo](./images/branding-logo.png)`) but actual image generation is a follow-up task for engineering or a designer. Leave placeholder TODO comments where a screenshot would help:

```markdown
<!-- TODO: screenshot — Branding settings page with logo upload area highlighted -->
```

### Code, IDs, and example data
- Use realistic but obviously-fake example data ("Smith Family Travel," "smithfamily.example.com").
- Wrap UI labels in bold ("click **Save changes**").
- Wrap field names in backticks (the `Custom domain` field).
- Use code blocks for any CNAME records, DNS entries, or copy-paste content.

### Frontmatter
Each file starts with YAML frontmatter:

```yaml
---
title: Getting started
description: Set up your tenant for the first time and complete onboarding.
slug: getting-started
order: 1
last_updated: 2026-05-15
tags: [onboarding, setup]
---
```

The slug and order are used by the docs viewer. The `description` is used as the search snippet.

---

## Troubleshooting authoring (12-troubleshooting.md)

This doc is different from the others. It is reference-style, organized by symptom. For each symptom:

- Bold short symptom statement.
- "What's happening" — brief explanation.
- "What to try" — ordered list of remediation steps.
- "If that doesn't work" — escalation path.

Symptoms to cover (build from your knowledge of v6 spec edge cases):
- Custom domain stuck in "Pending" verification
- RAG content stuck in queue
- Customer chat says "Our AI is taking a brief break"
- Booking submission failed
- Stripe Connect onboarding incomplete
- Email not arriving (Resend configuration / SPF)
- Tier limit hit (soft1/soft2/hard states)
- Sub-host status stuck in "pending_review"
- Persona returns generic answers (RAG empty for tenant)

For each, derive from v6 spec only. If you can't ground a symptom in spec behavior, drop it rather than invent.

---

## Quality gates

After writing all 12 files, run these checks before declaring done:

1. **Spec grounding** — for each doc, list the v6 spec sections you cited. Any doc with zero spec citations needs review.
2. **Cross-link integrity** — every relative link points to a real file in the set.
3. **Length sanity** — word count per doc; flag any outside the 800–1,500 range (or 2,500 for troubleshooting).
4. **Tone consistency** — re-read all 12 in one pass for voice drift between docs.
5. **No forbidden patterns**:
   - No spec references like "§16.3"
   - No emoji
   - No marketing language ("powerful," "seamless," etc.)
   - No invented features
6. **Frontmatter completeness** — every file has all required fields.
7. **Build viewer test** — render the Markdown through the docs viewer pipeline locally and visually scan for broken formatting.

---

## Out of scope

- Image generation. Leave TODO placeholders.
- Customer-facing docs (the customer doesn't visit `/admin/help`). Deferred per addendum scope.
- Non-English translations. Deferred per v6 §25.8.
- Video content.
- API documentation for tenants. The v6 spec is internal; if tenants need API docs later, that's a separate effort.
- Auto-generating the doc viewer or export pipeline — that's covered in the main Self-Service Help build prompt.

---

## Hand-off deliverables (in chat, not files)

When complete, in chat:

- Coverage mapping (the table you built in pre-work, updated with final spec citations per doc).
- Word count per doc.
- List of gaps you encountered — topics the v6 spec didn't cover and you flagged rather than invented.
- List of TODO image placeholders by doc.
- Suggested edits to MEMORY.md to capture any decisions you made during writing.
- Next step: run the "Populate Help Docs RAG" build prompt (separate file) to index these docs into the platform-docs scope.
