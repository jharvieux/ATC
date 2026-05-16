# Build Prompt — Generate Tenant Admin Help Documentation (v1.1)

**Version note:** v1.1 reframes the audience as travel agents (not generic SaaS users), adds a “Quick: how to…” opener to every doc, introduces a jargon checker as a hard quality gate, and adds a 13th file — a friendly glossary.

**Target:** Claude Code, working in the AI Travel Concierge monorepo.

**Source specs:**

- `AI_Travel_Concierge_Spec_v6_Full.docx` — primary source of truth for all feature behavior.
- `Self_Service_Help_Addendum_v1.docx` — specifies the doc set (§3.2) and storage path (§3.1).
- `MEMORY.md` — decision log; read before starting.

If any spec disagrees with this prompt, the spec wins. Flag the disagreement and stop for clarification.

-----

## Model usage instructions — read first

**Use Claude Sonnet for this entire task.** No Opus needed — this is well-scoped writing work where Sonnet performs well at much lower cost.

If you find yourself stuck on a structural decision (e.g., how to split a topic across two docs vs. keep in one), stop and ask the user rather than escalating to Opus.

-----

## What you’re producing

12 Markdown files of admin documentation plus 1 glossary file (13 total) in `apps/main/content/help/` that document the tenant admin console. These files are the source content for:

1. The onscreen documentation viewer (rendered to HTML at `/admin/help`).
1. The PDF and .docx export bundles.
1. The platform-docs RAG scope ingested by the parallel “Populate Help Docs RAG” build prompt.

Treat them as production user-facing documentation, not internal notes. They will be read by real tenant admins.

-----

## Pre-work — before you write any file

1. Read `Self_Service_Help_Addendum_v1.docx` §3.2 (the 12-file list) and §3.4 (RAG indexing). Note that v1.1 of this build prompt adds a 13th file (13-glossary.md) not in the addendum’s original list. Treat the glossary as part of the deliverable.
1. Read MEMORY.md for any prior decisions.
1. For each of the 13 doc files, identify which sections of the v6 spec contain the authoritative behavior. Build a mapping table — produce this in chat before writing any file so the user can confirm coverage. Example shape:
   
   ```
   01-getting-started.md          → v6 §15 (onboarding), §17 (auth signup flow)
   02-tenant-settings.md          → v6 §16 (branding partial), §1.4 (resolution)
   03-branding.md                 → v6 §16 (full), §29.4 (DNS), §29.12 (custom domain runbook)
   ...
   ```
1. Identify any gaps — topics in the doc plan that the v6 spec does NOT cover well. Surface these in chat before writing; do not invent behavior to fill them.

**Do not start writing docs until the user confirms the coverage mapping.**

-----

## File-by-file scope

Filenames are fixed (from addendum §3.2). Order is the order they appear in the doc viewer’s nav.

|File                        |Topic                                                     |Primary v6 spec sources                                           |
|----------------------------|----------------------------------------------------------|------------------------------------------------------------------|
|01-getting-started.md       |First-time setup, signup completion, initial configuration|§15 (Tenant Onboarding), §17 (Auth)                               |
|02-tenant-settings.md       |Business identity, contact info, time zone                |§1.4, §16                                                         |
|03-branding.md              |Logos, colors, custom domains                             |§16, §29.4, §29.12                                                |
|04-personas.md              |Configuring AI personas                                   |§10 (Supervisor context), persona definitions wherever they appear|
|05-crm.md                   |Contacts, relationships, pipeline                         |§12                                                               |
|06-quotes-and-bookings.md   |Quote builder, booking submission                         |§13, §20                                                          |
|07-rag-content.md           |Submitting content; review queue                          |§6, §22                                                           |
|08-usage-and-billing.md     |Tier, usage, billing, subscription management             |§14, §15.15, §27.11                                               |
|09-team-and-permissions.md  |Team members, role assignments                            |§26                                                               |
|10-customer-management.md   |Customer accounts, memory, escalations                    |§10.3, §11                                                        |
|11-supervisor-and-quality.md|Supervisor findings, escalations                          |§10                                                               |
|12-troubleshooting.md       |Common issues and diagnosis                               |Cross-cutting; see “Troubleshooting authoring” below              |
|13-glossary.md              |Plain-English definitions of unavoidable terms            |Cross-cutting; see “Glossary authoring” below                     |

If the v6 spec doesn’t cover something a tenant admin would obviously need (e.g., “how to reset my password” is auth flow but not deeply specified), call it out in your coverage mapping rather than improvising.

-----

## Authoring standards

### Audience

**The reader is a working travel agent, not a software professional.** Picture Sarah, who owns a 3-person independent travel agency. She has been booking trips for 15 years. She knows Outlook, Microsoft Word, her booking software (e.g., Sabre, Travelport, or ClientBase), and her phone. She has never written code, never edited DNS records, never heard “API” used as a noun. When something on a computer behaves unexpectedly, she’s already mildly frustrated before she opens a help article.

Write for Sarah specifically. Reference points for tone and depth: Mailchimp’s help center, Squarespace’s help center, HoneyBook’s getting-started guides. **Do NOT use Stripe, Linear, GitHub, Notion, or any developer-tools help center as a model** — they assume a technical reader and will lead you astray.

Implications:

- Assume zero technical vocabulary. The first time you must use a technical term, define it inline in parentheses, in friendly language. The 13th file (glossary) holds longer definitions for terms used across multiple docs.
- Step-by-step instructions are preferable to conceptual explanations almost everywhere. Where concepts are unavoidable, lead with the practical task and explain the concept after, not before.
- Anticipate frustration. If a step might fail (e.g., DNS hasn’t propagated yet), say “If you don’t see this right away, wait 10 minutes and try again — this is normal” rather than leaving the user stuck.
- Never tell the reader to “ask your developer” or “have your IT team…” — Sarah is the IT team. Either explain the step or route to the help chat.

### Voice

- Plain English. Active voice. Second person (“You can…”) not third.
- No marketing language (“powerful,” “seamless,” “leverage”). Say what it does.
- Short paragraphs. Frequent headings. Lots of step-by-step ordered lists where the action is procedural.
- No emoji.
- When a feature has a non-obvious limit or trade-off, mention it inline rather than burying it.

### Structure for each doc

Every doc opens with three things, in order:

1. **A one-sentence summary** of what the doc covers. Plain English. Active voice.
1. **A “Quick: how to…” section** with the most common task in this doc as a 5-step (or fewer) ordered list. No preamble, no conceptual setup. The user lands on the page, reads this section, and can complete the most common task without reading anything else. If a doc has no obvious single most-common task (e.g., the troubleshooting doc), skip this section.
1. **A bulleted “In this article” overview** (3–6 items) listing the main sections below.

Then sections. Use H2 (`##`) for major sections, H3 (`###`) for subsections. Avoid H4 unless truly necessary.

The Quick section’s job is to serve the 80% of readers who want to do the most common thing. Conceptual depth and edge cases come after, for the 20% who need more.

**Example of a Quick section, for `03-branding.md`:**

```markdown
## Quick: how to add your logo

1. From the admin menu, click **Branding**.
2. Click **Upload logo**.
3. Choose your logo file (PNG or JPG, square works best).
4. Click **Save changes**.
5. Your logo now appears at the top of your customer-facing pages.

That's it for the basic setup. The rest of this article covers custom colors, custom domains, and what to do if your logo looks wrong.
```

Each doc closes with:

- A “Related articles” section linking to other docs in the set.
- A “Still stuck?” line pointing to the help flows (“Open a help chat from the top right of this page” or similar).

### Length

- Aim for 800–1,500 words per doc. Going significantly over suggests the doc should be split.
- 12-troubleshooting.md may run longer (up to ~2,500) because it’s reference-style.

### Cross-references between docs

Use relative Markdown links: `[branding setup](./03-branding.md#custom-domains)`.

### Cross-references to the v6 spec

Do NOT reference the v6 spec in user-facing docs. The spec is internal. If you find yourself wanting to say “per §16.3 of the spec,” rewrite to describe the behavior directly.

### Screenshots and images

Do NOT generate or reference image files in v1. The file structure should support images (`![Add logo](./images/branding-logo.png)`) but actual image generation is a follow-up task for engineering or a designer. Leave placeholder TODO comments where a screenshot would help:

```markdown
<!-- TODO: screenshot — Branding settings page with logo upload area highlighted -->
```

### Code, IDs, and example data

- Use realistic but obviously-fake example data (“Smith Family Travel,” “smithfamily.example.com”).
- Wrap UI labels in bold (“click **Save changes**”).
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

### Jargon: the forbidden-words list

This is the single most important authoring rule. Every word in the list below is **banned** from user-facing docs unless it appears inside a code block (where a literal value is required) or as a defined term that has been introduced in the glossary file (13-glossary.md) and used carefully.

|Banned word/phrase             |What to write instead                                              |
|-------------------------------|-------------------------------------------------------------------|
|CNAME                          |“a special web address pointer your domain registrar sets up”      |
|DNS                            |“your domain’s settings at the company you bought your domain from”|
|API                            |(avoid entirely; rewrite to describe what the platform does)       |
|endpoint                       |(avoid entirely)                                                   |
|payload                        |“the information sent”                                             |
|async / asynchronous           |“in the background” or “this may take a few minutes”               |
|JSON / JSON object             |(avoid entirely; describe the data plainly)                        |
|JWT / token (auth context)     |“your sign-in”                                                     |
|OAuth                          |“signing in with Google/Microsoft/etc.”                            |
|schema / table / row / column  |“your information” or describe what’s stored                       |
|RAG                            |“the knowledge your AI uses to answer questions”                   |
|embedding                      |(avoid; usually replaceable by “your content”)                     |
|webhook                        |“a notification we send”                                           |
|scope (RAG/permission)         |“what content is visible to whom”                                  |
|tenant                         |“your business” or “your account”                                  |
|sub-host                       |“your business” (Sarah doesn’t know she’s a sub-host)              |
|supervisor (AI sense)          |“our quality check”                                                |
|persona (AI sense)             |“your AI assistant”                                                |
|ingestion / ingest             |“adding” or “uploading”                                            |
|upsert                         |“save”                                                             |
|backend / frontend / serverless|(avoid entirely)                                                   |
|deploy / deployment            |“release” or “update”                                              |
|repo / repository              |(avoid entirely)                                                   |
|migration (DB)                 |(avoid; not user-visible anyway)                                   |
|latency                        |“speed” or “how long it takes”                                     |
|4xx / 5xx / HTTP error code    |“an error message”                                                 |
|cache / cached                 |“saved for faster loading” (only mention if user-visible)          |
|environment variable           |(avoid; not user-visible)                                          |
|feature flag                   |(avoid; not user-visible)                                          |
|RLS / row-level security       |(avoid; not user-visible)                                          |
|auth / authentication          |“signing in”                                                       |
|credentials                    |“username and password” (or “sign-in details”)                     |
|revoke / revocation            |“remove access”                                                    |
|idempotent                     |(avoid; describe the behavior plainly)                             |
|race condition / deadlock      |(avoid; describe what the user experiences)                        |

This list is not exhaustive. The general rule: **if you would have to define the word for someone who has never used a developer tool, the word doesn’t belong in the docs.**

There are a few unavoidable terms that DO appear in the platform’s UI itself (e.g., “Branding,” “Personas,” “Quotes”). These are fine because they are the literal names of features. Use them with brief friendly definitions in the glossary.

If you genuinely need a technical term in a doc, the rule is:

1. Introduce it once in plain language (“a custom domain is a web address you own, like travel.smithagency.com, instead of the default one we give you”).
1. After introduction, you may use the term within that doc.
1. Add it to the glossary (13-glossary.md) if it’s used in more than one doc.

### Tone smell test

Re-read each paragraph and ask: would Sarah read this and feel smart, or feel stupid? If she’d feel stupid, rewrite. If she’d put the help article down and call someone, rewrite. The bar is: she should be able to follow each step without needing to ask anyone for help.

-----

## Troubleshooting authoring (12-troubleshooting.md)

This doc is different from the others. It is reference-style, organized by symptom. For each symptom:

- Bold short symptom statement.
- “What’s happening” — brief explanation.
- “What to try” — ordered list of remediation steps.
- “If that doesn’t work” — escalation path.

Symptoms to cover (build from your knowledge of v6 spec edge cases):

- Custom domain stuck in “Pending” verification
- RAG content stuck in queue (in the docs: “knowledge you uploaded hasn’t appeared yet”)
- Customer chat says “Our AI is taking a brief break”
- Booking submission failed
- Stripe Connect onboarding incomplete
- Email not arriving (in the docs: “customers aren’t receiving emails from your account”)
- Tier limit hit (in the docs: “your usage limit warning”)
- Sub-host status stuck in “pending_review” (in the docs: “your account is still being reviewed”)
- Persona returns generic answers (in the docs: “your AI assistant seems to be missing information about your business”)

For each, derive from v6 spec only. If you can’t ground a symptom in spec behavior, drop it rather than invent.

The jargon rules apply here too. Translate the symptom into language Sarah would use to describe what she sees, not what the platform engineer would call it.

-----

## Glossary authoring (13-glossary.md)

The glossary is a plain-English dictionary of unavoidable platform terms. It is the safety valve for the jargon rule: if a term genuinely must appear somewhere in the docs, it gets a friendly definition here.

Structure:

```markdown
---
title: Glossary
description: Plain-English definitions of terms used in your admin console.
slug: glossary
order: 13
last_updated: 2026-05-15
tags: [reference]
---

# Glossary

A friendly list of terms you'll see in your admin console, explained in plain English.

## Branding
The settings page where you upload your logo, choose your colors, and set up a custom web address.

## Custom domain
A web address you own (like `travel.smithagency.com`) that you can use instead of the default address we give you. Setting one up requires a small change at the company where you bought your domain name. See [the branding guide](./03-branding.md) for step-by-step instructions.

## Persona
The AI assistant on your customer-facing site. You can have more than one — for example, one for honeymoons and one for family trips. Each one has its own personality and knowledge.

## Quota / usage
The amount of activity included in your current plan. Each plan has limits on things like AI chats and customer accounts. When you get close to a limit, you'll see a warning.

## Quote
A trip proposal you build for a customer — itinerary, pricing, and details. Customers can review and accept quotes online.

## RAG content
(See "Your knowledge base" below — this is the technical name we don't use in the rest of the docs.)

## Sub-host
The technical name for your business account on our platform. You'll rarely see this term; we usually just say "your account."

## Supervisor
A behind-the-scenes quality check on every AI response your customers receive. It catches mistakes before they reach the customer.

## Tenant
Same as "sub-host" — the technical name for your account. You'll occasionally see this in error messages or system emails.

## Your knowledge base
The collection of information your AI uses to answer customer questions — your trip catalog, your destination guides, your past quotes, and anything else you've uploaded.
```

Add entries for any term the writer used in another doc that needed clarification. Aim for friendliness over completeness. If a term has both a technical name and a friendly version (e.g., “tenant” vs. “your account”), define both and explain which one users will see where.

The glossary is the ONE place where the docs acknowledge that technical names exist behind the scenes. Sarah might encounter “tenant” in a system email and want to know what it means; this is where she finds out.

Length: aim for 500–1,000 words. This doc is reference-style, not narrative.

-----

## Quality gates

After writing all 13 files, run these checks before declaring done:

1. **Spec grounding** — for each doc, list the v6 spec sections you cited. Any doc with zero spec citations needs review (except 13-glossary.md, which is by nature cross-cutting).
1. **Cross-link integrity** — every relative link points to a real file in the set.
1. **Length sanity** — word count per doc; flag any outside the 800–1,500 range. Exceptions: 12-troubleshooting.md up to ~2,500; 13-glossary.md 500–1,000.
1. **Tone consistency** — re-read all 13 in one pass for voice drift between docs. Apply the Sarah smell test: would she feel smart or stupid reading each section?
1. **Jargon check (hard gate)** — programmatically scan each doc against the forbidden-words list above. ANY occurrence outside a code block or glossary definition is a fail. Failures must be fixed before declaring done. Report a final tally of jargon catches per doc (should be 0).
1. **Quick-task opener present** — every doc except 12-troubleshooting.md and 13-glossary.md has a “Quick: how to…” section as the second element after the summary.
1. **No forbidden patterns**:

- No spec references like “§16.3”
- No emoji
- No marketing language (“powerful,” “seamless,” “leverage,” “robust,” “best-in-class”)
- No invented features
- No “ask your developer” or “have your IT team…”

1. **Frontmatter completeness** — every file has all required fields.
1. **Build viewer test** — render the Markdown through the docs viewer pipeline locally and visually scan for broken formatting.
1. **Glossary coverage** — any term flagged as “introduce in glossary if used in 2+ docs” actually appears in 13-glossary.md.

-----

## Out of scope

- Image generation. Leave TODO placeholders.
- Customer-facing docs (the customer doesn’t visit `/admin/help`). Deferred per addendum scope.
- Non-English translations. Deferred per v6 §25.8.
- Video content.
- API documentation for tenants. The v6 spec is internal; if tenants need API docs later, that’s a separate effort.
- Auto-generating the doc viewer or export pipeline — that’s covered in the main Self-Service Help build prompt.

-----

## Hand-off deliverables (in chat, not files)

When complete, in chat:

- Coverage mapping (the table you built in pre-work, updated with final spec citations per doc).
- Word count per doc.
- List of gaps you encountered — topics the v6 spec didn’t cover and you flagged rather than invented.
- List of TODO image placeholders by doc.
- Suggested edits to MEMORY.md to capture any decisions you made during writing.
- Next step: run the “Populate Help Docs RAG” build prompt (separate file) to index these docs into the platform-docs scope.