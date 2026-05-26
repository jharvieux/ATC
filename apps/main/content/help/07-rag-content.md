---
title: RAG content — teaching your concierge
slug: rag-content
order: 7
category: daily
tiers: [byo_research, byo_professional, byo_agency, sub_starter, sub_pro, sub_agency]
---

# RAG content — teaching your concierge

> **Available on:** all tiers.

"RAG" stands for retrieval-augmented generation. In plain English: the
AI looks things up before answering, so it can use your knowledge
instead of guessing.

You feed the system content — your supplier sheets, your travel
guides, your FAQs — and the AI uses that content when relevant
customer questions come up.

## What good RAG content looks like

- **Cruise line policies** — refund windows, child fares, future cruise
  credit rules.
- **Itinerary notes** — your tips about specific ports, excursions you
  trust, restaurants to recommend.
- **Supplier sheets** — preferred-rate lists, commission percentages
  (the AI sees commissions but never quotes them to customers).
- **FAQs** — answers to questions you get often.
- **Local travel rules** — passport requirements, vaccination
  paperwork, customs notes.

## Three ways to submit content

### 1. Web form

The simplest path:

1. Open **CRM → RAG content → Submit new**.
2. Paste a URL or upload a document (PDF, DOCX, plain text).
3. Optionally give it a title and category.
4. Click **Submit**.

The AI extracts the content, cleans it up, removes any private
customer info it spots, and queues it for your review.

[Screenshot: RAG submit form with the URL and file upload fields]

### 2. Browser extension

Install the platform's browser extension. While reading any web page,
click the extension icon → **Submit this page**. The current page goes
to your queue.

Best for: clipping cruise-line update emails, sale notifications,
articles you want the AI to know about.

### 3. iOS shortcut

For iPhone users: install the platform's iOS shortcut from the App
Store link in **Settings → Mobile**. Then on any page (Safari, Mail,
Notes), tap **Share → AI Travel Concierge** to submit.

## The review queue

Every submission lands in **CRM → RAG content → Review queue** as
**Pending review**. This is your safety check.

Open the queue, click any item to expand:

- **AI summary** — the platform's one-paragraph version of what the
  content says.
- **Suggested category** — what topic the AI thinks this belongs to.
- **Suggested tags** — keywords the AI extracted.
- **Raw content** — the full text, with any PII (names, emails) shown
  in `[redacted]`.

If it looks good, click **Approve**. The content becomes searchable to
the AI within five minutes.

If it's wrong, click **Reject** and tell us why — the reason helps the
AI learn what your team finds useful versus noise.

[Screenshot: RAG review queue page with an expanded item showing the AI summary]

### Bulk approve

For up-to-10 items at a time, tick the checkboxes and click **Bulk
approve** — the platform approves them in one go without further
prompts.

For more than 10 at once, the platform shows a confirmation dialog
asking if you've reviewed each one. Don't bulk-approve content you
haven't actually read — bad RAG content makes the AI worse, not better.

## Categories that work well

We've seen these categories produce the most useful AI behavior:

- `cruise-line-policy` — official rules from cruise lines
- `port-tips` — your knowledge about specific ports
- `excursions-recommended` — excursions you'd send a customer on
- `excursions-avoid` — excursions to steer customers away from
- `supplier-pricing` — your preferred rates
- `internal-procedures` — how your agency handles edge cases

You can use any category name — these are just suggestions that we see
working.

## What happens after approval

Approved content becomes a "chunk" the AI can retrieve. When a
customer asks something that matches your content, the AI:

1. Searches your approved chunks.
2. Pulls the top 3-5 most relevant.
3. Uses them to answer.
4. Cites them in its response (so you can audit which content drove
   which answer).

## Global library candidates

Sometimes content you submit is genuinely useful to other tenants —
public cruise-line policies, port descriptions, customs rules. When
the platform detects this, the item shows **Flagged: candidate for
global library**.

You can still approve it for your own use. If you want to share it
with the broader platform, click **Submit to global library** — our
team reviews and (if appropriate) makes it available to other tenants.
You stay credited as the contributor.

## Frequently asked

**The AI ignored content I approved.** The retrieval is "best match"
— if your content didn't match the customer's question closely enough,
it doesn't get used. Check your category and tags; broaden them if
they're too narrow.

**My queue has hundreds of items.** Use the category and source-type
filters at the top of the queue to triage. Reject obvious noise first
(usually web-clip junk) then work through the real content.

**A customer's private info appeared in extracted content.** That's a
redaction miss. Click **Reject** with reason "PII not redacted" — we
investigate every PII miss as a platform bug.
