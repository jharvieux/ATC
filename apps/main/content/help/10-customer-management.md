---
title: Customer management
slug: customer-management
order: 10
category: daily
tiers: [byo_research, byo_professional, byo_agency, sub_starter, sub_pro, sub_agency]
---

# Customer management

> **Available on:** all tiers. Group bookings and bulk-email tools
> require Pro or above.

This page covers the day-to-day customer flows that don't fit
elsewhere: handling escalations, merging duplicate contacts, group
bookings, and managing customer requests for their data.

For the basics of contacts and the AI memory, see [CRM](./05-crm).

## When a customer asks to speak to a human

It happens. A customer types "Can I talk to a real person?" — or the
AI itself escalates because the customer is frustrated, the question
is out of scope, or a high-stakes decision is being made.

You'll see the escalation in two places:

- A red dot in the top nav, next to **Conversations**.
- An email to the tenant's escalation address (set in **Settings →
  Notifications**).

[Screenshot: Conversations list with a red dot indicating an escalation]

To take over:

1. Click the conversation in **CRM → Conversations**.
2. Click **Take over from AI** (top right).
3. Type your reply. The customer sees a small note: "You're now
   chatting with a human."

The AI stays out of the conversation until you click **Hand back to
AI** — useful for routine follow-ups after you've handled the hard
part.

## Why the AI escalated

When the AI hands a conversation to you, it explains why in a small
panel above the message thread:

- **"Customer expressed frustration"** — sentiment dropped, AI couldn't
  recover.
- **"Out of scope question"** — the question was outside what the AI is
  trained for.
- **"Contract-formation risk"** — the customer was about to commit to
  something binding (price, date, refund). Always check this before
  responding.
- **"Customer requested human"** — explicit request.

Address the customer first, then the underlying reason — the AI will
learn from your handling.

## Merging duplicate contacts

When the same person creates multiple contacts (e.g., chats from work
email, then from personal email):

1. **CRM → Contacts → search** for likely duplicates.
2. Select two (or more) rows with the checkboxes.
3. Click **Actions → Merge**.
4. The platform shows a side-by-side. Pick the master record's name,
   email, phone, etc.
5. Click **Merge contacts**.

The AI memory from both records combines. Conversations, quotes, and
bookings all move to the master record. The other records are
soft-deleted.

> Merge is reversible for 7 days. After that the soft-deleted record
> is purged permanently.

## Group bookings (Pro and above)

> **Available on:** Pro, Agency, BYO Agency.

For groups of 10+ cabins, the standard quote flow gets unwieldy. Use
the dedicated group flow:

1. **CRM → Quotes → New group quote**.
2. Name the group ("Anderson Family Reunion 2026").
3. Pick the group leader (one of your existing contacts, or add new).
4. Define the cruise: line, ship, sail date, cabin tiers, group rate.
5. Set the deposit deadline and final-payment deadline.
6. Click **Save and send invitations**.

[Screenshot: Group quote creation form with the cabin-tier table]

Each invitee receives a personalized email with a link to:

- See the group's itinerary and pricing
- Pick their cabin (within the tiers you defined)
- Pay their deposit

You see live status: who's accepted, who's paid, who's pending. Use
**Bulk reminder** to nudge the stragglers.

### Group booking edge cases

- **Someone wants a different cabin tier than offered** — handle by
  hand in their individual booking page; the group rate still applies
  if you flag it.
- **The group leader changes mid-trip-planning** — open the group page,
  click **Change leader**, pick a different contact.
- **A cabin assignment falls through** — open the booking, click
  **Cancel and reopen cabin**. The cabin becomes available again for
  another invitee or a walk-in.

## Customer data requests

Customers have a legal right to know what data you hold about them
and to ask for it to be deleted.

### "Send me my data"

1. Open the contact.
2. Click **Export contact data**.
3. The platform generates a PDF with: contact info, all conversations,
   AI memory, quotes, bookings, emails.
4. Email the PDF to the customer.

The export typically completes in under a minute. You have 30 days
under most privacy laws to fulfill these requests — same-day is best
practice.

### "Delete my data"

1. Open the contact.
2. Click **Delete contact**.
3. Confirm.

What happens:

- The contact's record is soft-deleted (recoverable for 7 days).
- After 7 days, it's purged from the live database.
- It remains in encrypted backups until the backups themselves age out
  (typically 30 days).
- After 37 days total, the data is gone.

Conversations involving this customer stay visible to you (because
they include your team's responses too) but the customer's name is
replaced with "Deleted contact" and their email is removed.

> If the customer also asks you to delete their data from your other
> systems (email provider, accounting software), do that separately —
> the platform can only delete from itself.

## Bulk email (Pro and above)

> **Available on:** Pro, Agency, BYO Agency.

For newsletters, sale announcements, and seasonal greetings:

1. **CRM → Contacts → select** your audience (use tags or filters).
2. Click **Actions → Send bulk email**.
3. Pick a template or write from scratch.
4. Preview, then click **Send**.

Bulk emails respect each contact's unsubscribe preferences
automatically. Contacts who unsubscribe go in a "do not contact" state
across the platform.

[Screenshot: bulk-email composer with the recipient count visible]

## Frequently asked

**A customer keeps showing up as a new contact every chat.** The AI
matches contacts by email. If they're not sharing their email in chat,
the AI can't match. Edit your personas to ask for email earlier in
the conversation (or rely on contact import).

**Can the AI handle a refund?** It can quote the policy and walk the
customer through the steps, but the actual refund processing happens
in your cruise-line / supplier system. Escalate refund requests to a
human early.

**I need to track which website / ad brought a lead in.** Use the
"lead source" field on each contact and the **CRM → Reports → Leads
by source** report.
