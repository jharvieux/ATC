---
title: CRM — Customers and contacts
slug: crm
order: 5
category: daily
tiers: [byo_research, byo_professional, byo_agency, sub_starter, sub_pro, sub_agency]
---

# CRM — Customers and contacts

> **Available on:** all tiers.

The CRM is where you see every customer who's talked to your AI
concierge, plus contacts you import from your existing book of
business.

Open **CRM → Contacts** from the top navigation.

[Screenshot: CRM Contacts list view with several contacts]

## What appears here

- **AI conversation contacts** — anyone who chatted with your concierge
  and shared their name or email. Auto-created.
- **Imported contacts** — your existing customer list. You import them
  yourself (see below).
- **Manually added contacts** — anyone you add by hand.

Each contact row shows: name, email, last activity date, lifetime
spend (if known), and the AI-extracted "memory summary" of what you
know about them.

## The AI memory column

This is one of the platform's most valuable features. For every
conversation, the AI extracts and saves what it learned about the
customer — preferences, family details, past trips, deal-breakers.

Click any contact to see the full memory:

- **Preferences** (e.g., "prefers balcony cabins, never inside")
- **Family** (e.g., "wife Sarah, kids Jacob 12 and Emma 9")
- **Past trips** (e.g., "Caribbean March 2024 on Royal Caribbean")
- **Conversation history** with persona used for each

[Screenshot: contact detail page with the AI memory panel highlighted]

The AI uses this memory in every new conversation, so your concierge
"remembers" the customer the way you would.

## Importing your existing book

If you already have a customer list in another system:

1. Export your list as CSV from your other system.
2. In the platform: **CRM → Imports → Manual import**.
3. Click **Choose file** and pick your CSV.
4. Map the columns (the platform guesses; check before clicking
   **Import**).
5. Wait for the import to finish — usually under a minute for lists up
   to 10,000 contacts.

[Screenshot: CRM Imports page with the column-mapping table]

### What to put in the CSV

At minimum: first name, last name, email. Optional but useful: phone,
last-trip date, last-trip destination, notes.

The AI uses any notes you import as the starting "memory" for that
contact. Plain-English notes work best — write the way you'd describe
the customer to a colleague.

## Adding a contact by hand

For one-offs:

1. **CRM → Contacts → New contact** (top right).
2. Fill in at least first name and email.
3. Click **Save**.

## What contacts can do

- **Email the customer directly** from the contact detail page.
- **Start a conversation on their behalf** — useful if a customer
  calls you and you want the AI to draft a follow-up. The conversation
  appears in their history as if they typed it.
- **Mark as VIP** — VIP contacts skip the "Powered by" message on
  emails and get a higher-priority queue when supervisor review is
  needed.

## Privacy and data export

Customers can request a copy of everything you know about them. From
the contact detail page, click **Export contact data** to generate a
PDF with their conversations, memory, and emails.

If a customer asks you to delete their data, use **Delete contact**.
This is permanent and triggers our 7-day soft-delete window before the
data is purged from backups.

See [Customer management](./10-customer-management) for advanced flows
like merging duplicate contacts, group bookings, and lead source
tracking.

## Frequently asked

**A contact has the wrong AI memory.** Click the memory item to edit
it. The AI uses your edited version going forward.

**Two contacts are the same person.** Use **Merge** (CRM → Contacts →
select both → Merge). The platform combines histories and prompts you
to keep the better name/email.

**I want to bulk-tag contacts.** Select multiple rows, then use
**Actions → Add tag**. Tags help you filter and run group emails.
