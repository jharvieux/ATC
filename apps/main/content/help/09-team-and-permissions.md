---
title: Team and permissions
slug: team-and-permissions
order: 9
category: setup
tiers: [byo_research, byo_professional, byo_agency, sub_starter, sub_pro, sub_agency]
---

# Team and permissions

> **Available on:** all tiers. Team-size limits depend on your tier
> — see [Usage and billing](./08-usage-and-billing).

The Team and Permissions page is where you control who has access to
your tenant, and what each person can do.

Open **Settings → Team and permissions**.

[Screenshot: Settings → Team and permissions page with the user list]

## Adding a teammate

1. Click **Invite a teammate** (top right).
2. Enter their email address.
3. Pick a **role** (see below).
4. Click **Send invite**.

The platform emails them a one-click link to set their password and
join. The link expires in 7 days; resend if it expires.

## The roles

We use a small set of roles instead of fine-grained permissions, so
it's easy to think about who can do what.

### Owner

- One per tenant.
- Can do everything, including changing billing and deleting the
  tenant.
- Cannot be removed except by transferring ownership first.

### Admin

- Can do everything except billing and tenant deletion.
- Good for senior team members who help you run the agency.

### Agent

- Can talk to customers, create quotes, manage their own contacts.
- Cannot change tenant settings, branding, or AI configuration.
- Best for most team members.

### Read-only

- Can view conversations, contacts, quotes, and reports.
- Cannot edit anything or send messages.
- Best for accountants, auditors, observers.

### Subcontractor (Pro and above)

> **Available on:** Pro, Agency, BYO Agency.

- Scoped access to a specific subset of conversations.
- Used when you outsource quality review or after-hours coverage.
- Every action they take is audited so you can prove compliance later.
- See **Settings → Subcontractors** for advanced configuration.

## Changing someone's role

1. Open **Settings → Team and permissions**.
2. Click the role dropdown next to the user.
3. Pick a new role.

The change takes effect immediately. The user keeps their current login
session but sees new (or removed) menu items on their next page load.

## Removing access

When a teammate leaves your agency:

1. Open **Settings → Team and permissions**.
2. Click **Remove** next to their name.

What happens:

- Their login is invalidated within 60 seconds.
- Conversations they own are reassigned to you (the Owner).
- Their action history stays in the audit log for 7 years (legal
  requirement).
- They can no longer see any of your tenant's data.

> If a teammate left under bad circumstances, also rotate any shared
> credentials they had access to outside the platform (Anthropic API
> key, supplier portals, etc).

## Audit log

Every settings change, role assignment, and admin action is logged.
View it at **Settings → Team and permissions → Audit log** (only
visible to Owners and Admins).

[Screenshot: Audit log showing recent actions with timestamps and user names]

What's logged:

- User invitations and role changes
- Branding and persona edits
- AI mode changes
- Billing updates
- RAG content approvals and rejections
- Customer data exports and deletions

What's NOT logged (because they're not security-relevant):

- Conversation messages (those have their own retention)
- Page views

Logs are immutable — neither we nor you can edit them after the fact.

## Two-factor authentication

We strongly recommend every teammate enables two-factor authentication
(2FA):

1. The teammate clicks their profile picture → **My account**.
2. Click **Set up 2FA**.
3. Scan the QR code with an authenticator app (Authy, Google
   Authenticator, 1Password, etc.).
4. Save the recovery codes somewhere safe.

You can require 2FA for all teammates in **Settings → Team and
permissions → Security → Require 2FA**.

## Frequently asked

**I invited someone but they didn't get the email.** Check their spam
folder. If still missing, click **Resend invite** on the user row.

**Two people own the same tenant — is that possible?** No. There's one
Owner. Make the other person an Admin if they need full access. To
transfer ownership: Owner clicks **Transfer ownership** on the user
row.

**A teammate has the wrong role permanently.** Their browser may be
caching an old session. Have them log out and back in.

See [Troubleshooting](./12-troubleshooting) for sign-in issues.
