---
title: Supervisor and quality
slug: supervisor-and-quality
order: 11
category: ops
tiers: [byo_research, byo_professional, byo_agency, sub_starter, sub_pro, sub_agency]
---

# Supervisor and quality

> **Available on:** all tiers — but advanced quality controls (bad-
> answer feedback, eval re-scoring, persona quality dashboards)
> require Pro or above.

The Supervisor is the platform's built-in quality control. It watches
every AI response in real time and catches problems before customers
see them.

This help page explains what the Supervisor does, what you'll see in
the platform when it acts, and how to give feedback that improves
quality over time.

## What the Supervisor does

Before any customer-facing AI message is sent, the Supervisor:

1. Reads the AI's draft response.
2. Checks it against a set of safety and quality rules.
3. Either lets it through, asks the AI to retry, or escalates to a
   human.

Most messages pass through silently — you never know the Supervisor
was involved.

## What you'll see when the Supervisor acts

### "Message held for review" badge

If the Supervisor isn't sure, it holds the draft and shows a small
yellow badge in the conversation:

[Screenshot: Conversation thread with a held message showing the yellow Held for review badge]

You'll see the message, the AI's reasoning, and what the Supervisor
flagged. Click **Approve and send** if it's fine, or **Edit and send**
if it needs a tweak.

The customer doesn't see anything during the hold — to them, the AI is
just thinking a beat longer. Most holds resolve in under 30 seconds.

### "Escalated to human" notification

If the Supervisor is confident the AI shouldn't respond, it escalates.
You get a notification (in the platform and via email), and the
customer sees:

> "I want to make sure I get this right for you. A member of our team
> will be with you in a moment."

See [Customer management](./10-customer-management) for the full
take-over flow.

## What the Supervisor flags most often

- **Contract-formation risk** — the AI was about to commit to a
  specific price, date, or refund that would bind your agency.
- **Sensitive topics** — health conditions, accessibility requests,
  cancellation/refund situations.
- **Customer escalation** — sentiment dropped sharply, customer
  expressed frustration.
- **Out-of-scope** — questions outside travel (legal advice, medical
  advice, financial planning).
- **Factual uncertainty** — the AI's confidence dropped below the
  quality threshold.

Each flag has a different recommended action — the Supervisor includes
guidance in the held-message panel.

## Giving feedback that improves the AI (Pro and above)

> **Available on:** Pro, Agency, BYO Agency.

You can teach the platform to be better, one message at a time.

### Mark as bad answer

Open any conversation. Hover over an AI message. Click **⋯ → Mark as
bad answer**. You'll be asked:

- **What was wrong?** Pick from a short list:
  - Factually incorrect
  - Off-tone for our brand
  - Recommended a competitor
  - Missed our preferred supplier
  - Other
- **What would the right answer have been?** (optional but helpful)

The platform's evaluation harness re-scores the persona's behavior on
similar inputs nightly. You'll see the result in the **Persona quality
dashboard** within 48 hours.

[Screenshot: a conversation with the Mark as bad answer modal open]

### Mark as great answer

The opposite: when the AI does something especially well, hover the
message and click **⋯ → Mark as great**. This reinforces the behavior
in future evals.

## The Persona Quality dashboard (Pro and above)

> **Available on:** Pro, Agency, BYO Agency.

**CRM → Reports → Persona quality** shows:

- Each persona's quality score (running 30-day average)
- The trend (improving / steady / declining)
- The top 3 issues flagged for that persona this week
- Recommended actions (e.g., "consider adding an addendum about
  supplier preferences")

Use this report monthly to spot patterns. A persona declining in
quality usually means either (a) the world changed (cruise lines
launched new policies the AI doesn't know about — feed it via
[RAG content](./07-rag-content)) or (b) your customer mix shifted
(different questions than the persona was set up for).

## Eval failures and what to do

The platform runs nightly "eval" tests on every persona — fixed
questions with known good answers. If a persona fails its evals:

1. We email your Owner.
2. The persona is automatically switched to **Draft only** mode (so a
   human reviews everything).
3. Your team should investigate and either:
   - Update the persona's addendum (Pro and above)
   - Submit corrective RAG content
   - Email support — sometimes the failure is on our end

Eval failures are rare (usually one persona per quarter) but worth
treating seriously when they happen.

## Frequently asked

**The Supervisor is holding too many messages — my team is overloaded.**
That usually means your customer mix is in topics the AI is less
confident on. Two short-term fixes:

1. Switch to **Draft only** AI mode for a week and see what your team
   ends up editing — that's signal about where the AI needs help.
2. Add a persona addendum (Pro and above) clarifying your house style
   on the topics being flagged.

**The Supervisor approved something bad.** It happens. Mark the
message as a bad answer (see above) and the eval re-scoring will
catch the pattern. If the message caused real harm (cost the customer
money, broke their booking), email support — we want to investigate
every such case.

**I want to turn the Supervisor off.** You can't — it's load-bearing
for safety. You can switch AI mode to **Disabled** to stop the AI
entirely if you'd rather not use it at all.

See [Troubleshooting](./12-troubleshooting) for what to do when AI
behavior surprises you.
