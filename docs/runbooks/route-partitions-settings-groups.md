# Route-Tree Partition Rules for /settings and /groups

## Overview

The Next.js app/router has a deceptively flat URL surface because route groups (paths in parentheses) are invisible in URLs. This makes it easy to accidentally add features to only half of the route tree.

**The trap:** "Add X to all settings pages" means checking *both* `apps/main/src/app/settings/` AND `apps/main/src/app/(console)/settings/`. They serve different audiences, have different layouts, different gating conventions, and different sidebars.

This runbook documents the partition rules so you know which tree owns what.

---

## The `/settings/*` Split

### Customer-Personal Settings
**Route group:** Root `/settings/` (NOT under a route group)  
**File path:** `apps/main/src/app/settings/`  
**URL examples:**
- `/settings/profile`
- `/settings/privacy`
- `/settings/memory`
- `/settings/conversations`
- `/settings/price-watches`

**Served by:** `apps/main/src/app/settings/layout.tsx`

**Audience:**
- All roles (customers, agents, tenant owners) can access their own personal settings.
- These are *per-user*, not per-tenant.

**Chrome & Navigation:**
- `TenantTheme` applies tenant colors/fonts.
- `SiteHeader` shows the canonical role-aware navigation (hamburger menu, branding).
- Staff members see platform logo (§962 rule); customers see tenant white-label.
- The header's hamburger is the same menu on CRM/Dashboard — consistent nav everywhere.

**Gating Convention:**
- **No auth gate in the layout** — the layout does NOT call `assertPermission`.
- **Page-level gating:** Each page (e.g., `page.tsx` under `/privacy/`) asserts its own permissions via server components or client-side API hits.
- Server components redirect on 403; client components hit APIs that 401.

**New page checklist:**
- Place under `apps/main/src/app/settings/<feature>/page.tsx`.
- Add your own `assertPermission` check in the page component.
- Use the shared `settings/layout.tsx` — it provides TenantTheme + SiteHeader.

---

### Tenant Console Settings (Admin Settings)
**Route group:** `(console)` — path `apps/main/src/app/(console)/settings/`  
**File path:** `apps/main/src/app/(console)/settings/`  
**URL examples:**
- `/settings/billing`
- `/settings/users`
- `/settings/email-templates`
- `/settings/personas`
- `/settings/branding`
- `/settings/voice`
- `/settings/subcontractors`
- `/settings/host-integration`

**Served by:** `apps/main/src/app/(console)/layout.tsx`

**Audience:**
- Tenant admins, tenant owners, agents (staff-only pages).
- NOT available to customer-only roles.

**Chrome & Navigation:**
- `TenantTheme` applies tenant colors/fonts (but only for tab title; sidebar logo is platform-branded).
- `ConsoleShell` renders the left sidebar with admin-specific sections (billing, users, templates, personas, etc.).
- Platform logo always shown (never tenant white-label, even if the tenant is custom-branded).
- Sidebar is collapsible (state persisted in cookie).

**Gating Convention:**
- **No auth gate in the layout** — like settings/, the (console) layout does NOT gate.
- **Page-level gating:** Pages assert `assertPermission` with resource="tenant_settings" and appropriate actions.
- If no role resolves (anon user, or a member of a different tenant), the layout renders bare and lets the page redirect.

**New page checklist:**
- Place under `apps/main/src/app/(console)/settings/<feature>/page.tsx`.
- Add your own `assertPermission` check for staff-only roles.
- Use the shared `(console)/layout.tsx` — it provides TenantTheme + ConsoleShell.
- If the page needs custom sidebar logic, hook into ConsoleShell's role-driven sections.

**Note:** The distinction between `settings/` and `(console)/settings/` is intentional (#962 follow-up). They serve different audiences and have different navigation chrome.

---

## The `/groups/*` Split

### Group Membership (Tenant-Staff View)
**Route group:** `(tenant)` — path `apps/main/src/app/(tenant)/groups/`  
**File path:** `apps/main/src/app/(tenant)/groups/`  
**URL examples:**
- `/groups` — list of group bookings (staff-only view)

**Served by:** `apps/main/src/app/(tenant)/layout.tsx`

**Audience:**
- Tenant staff (agents, owners) only.
- Shows the staff-side group management interface.

**Chrome & Navigation:**
- Platform logo (AI Travel Concierge), never tenant white-label.
- SiteHeader + persistent WorkspaceSidebar on every staff page.
- Sidebar provides nav to CRM, Dashboard, Concierge, and Groups.

**Gating Convention:**
- **No auth gate in the layout** — the (tenant) layout does NOT call `assertPermission`.
- **Page-level gating:** Pages assert `assertPermission` with resource="groups" and appropriate actions.

**Structure:**
- `/groups` — page.tsx lists all group bookings for the tenant.
- `/groups/_components/` — shared UI components for the groups interface.
- No subpages (no `/groups/[id]/*` at this level).

---

### Group Customer-Facing Views
**Route group:** Root (NOT under a route group)  
**File path:** `apps/main/src/app/groups/`  
**URL examples:**
- `/groups/new` — group creation flow (customer-initiated).
- `/groups/[id]/coordinate` — group coordination & itinerary sync.
- Other subpages may exist under `/groups/[id]/*`.

**Served by:**
- Root app layout (or no explicit layout if inheriting from root).
- Each subpage may have its own `layout.tsx`.
- `/groups/[id]/coordinate/layout.tsx` likely provides coordinate-specific chrome.

**Audience:**
- Customers creating / managing group bookings.
- Booking group members coordinating before sailing.

**Gating Convention:**
- **Page-level gating:** Each page asserts its own permissions (e.g., "only the group organizer can edit").
- No layout-level gate (anonymous users can view public group pages if the group allows it).

**New page checklist:**
- Place under `apps/main/src/app/groups/<feature>/page.tsx`.
- Add your own gating logic (could be permission-based, could be public).
- If the page has sub-routes (e.g., `/groups/[id]/itinerary`), create a `layout.tsx` under `/groups/[id]/` to define shared chrome for all group-detail subpages.

---

## Partition Summary Table

| Purpose | Route Tree | File Path | Layout | Audience | URL Pattern |
|---------|-----------|-----------|--------|----------|------------|
| **Personal user settings** | Root `/settings/` | `app/settings/` | `settings/layout.tsx` (TenantTheme + SiteHeader) | All roles | `/settings/profile`, `/settings/privacy`, etc. |
| **Tenant admin console** | `(console)/settings/` | `app/(console)/settings/` | `(console)/layout.tsx` (TenantTheme + ConsoleShell) | Staff only | `/settings/billing`, `/settings/users`, etc. |
| **Staff group management** | `(tenant)/groups/` | `app/(tenant)/groups/` | `(tenant)/layout.tsx` (Platform logo + WorkspaceSidebar) | Staff only | `/groups` (list) |
| **Customer group creation & coordination** | Root `/groups/` | `app/groups/` | Per-feature `layout.tsx` or inherited | Customers | `/groups/new`, `/groups/[id]/coordinate`, etc. |

---

## Critical Rules

### Rule 1: Both /settings/ and (console)/settings/ exist for a reason.
Do NOT consolidate them. They serve different users, have different gating, and different workflows.

**❌ Wrong:** `app/(console)/settings/profile/` (profile is personal, not tenant admin).  
**✅ Right:** `app/settings/profile/` (personal settings live at the root).

**❌ Wrong:** `app/settings/billing/` (billing is tenant admin, not personal).  
**✅ Right:** `app/(console)/settings/billing/` (admin settings live under (console)).

### Rule 2: Route groups don't appear in URLs.
When planning a feature, remember that `/settings/X` could resolve to either `app/settings/X/` OR `app/(console)/settings/X/` depending on which layout it's under. The URLs are ambiguous.

**Solution:** Always grep for the feature path in *both* locations if you're unsure.

### Rule 3: Layouts do NOT gate; pages do.
Both `settings/layout.tsx` and `(console)/layout.tsx` explicitly do NOT call `assertPermission`. This keeps them flexible — they render whatever chrome is needed, and the page-level gate handles the auth check.

**Never add auth to a layout unless you're sure all descendant pages need the same check.** Layouts are meant to be flexible cruft providers, not security boundaries.

### Rule 4: New "add X to all settings pages" tasks require two PRs or a deliberate decision to break half of settings.

If you're asked to "add X to settings", ask: **"Which settings — personal (profile, privacy, memory) or admin (billing, users, templates)?"**

- Personal: use `app/settings/`.
- Admin: use `app/(console)/settings/`.
- Both: file two changes, or file one PR that touches both trees.

---

## Layout Documentation Headers

Both `settings/layout.tsx` and `(console)/layout.tsx` should include a comment at the top documenting which partition they own. Here's the template:

### For `apps/main/src/app/settings/layout.tsx`:
```typescript
// § 16 / § 24 — Shared layout for customer-personal settings pages.
// This layout owns: /settings/profile, /settings/privacy, /settings/memory,
// /settings/conversations, /settings/price-watches.
// 
// Serves ALL roles (customers, agents, tenant_owners) — each user's own
// personal settings. Pages MUST assert their own permissions.
//
// Provides: TenantTheme (colors + font) + SiteHeader (role-aware nav).
// Staff see platform logo; customers see tenant white-label.
//
// ⚠️ Partition rule: Personal settings live here (root /settings/).
// Tenant admin settings live under (console)/settings/ instead.
```

### For `apps/main/src/app/(console)/layout.tsx`:
```typescript
// § 16 — Shared layout for tenant Admin Console.
// This layout owns: /(console)/settings/*, /(console)/tenant-admin/*
//
// Serves staff only (tenant_owner, agent roles). Pages MUST assert
// their own permissions; layout does NOT gate.
//
// Provides: TenantTheme (colors + font) + ConsoleShell (admin sidebar).
// Platform logo always shown; never tenant white-label.
//
// ⚠️ Partition rule: Admin settings live here under (console)/settings/.
// Personal settings live at root /settings/ instead.
// ⚠️ Route group: (console) is invisible in URLs, so both /settings/billing
// (console) and /settings/profile (root) appear as /settings/* externally.
// Always check BOTH trees when adding settings features.
```

---

## Related Code Locations

- `apps/main/src/app/settings/layout.tsx` — personal settings layout
- `apps/main/src/app/(console)/settings/` — admin settings pages
- `apps/main/src/app/(console)/layout.tsx` — console shell + sidebar
- `apps/main/src/app/(tenant)/groups/` — staff group management
- `apps/main/src/app/groups/` — customer group creation & coordination
- `apps/main/src/app/(tenant)/layout.tsx` — staff area layout (CRM, Dashboard, etc.)

---

## Related Issues

- **#962** — staff-facing layout split (moved admin pages to (console) group)
- **#1008** — personal settings shared layout follow-up
- **#1603** — this documentation (you are here)

---

## Future Considerations

### Single Sign-On for Personal Settings
If personal settings pages ever need to be accessible *without* a tenant context (e.g., a user updating their email at the platform level, not the tenant level), consider whether they should live outside the tenant-aware layout tree entirely. For now, they are tenant-aware because `TenantTheme` and `SiteHeader` both assume a tenant context.

### Merging /settings/ and /(console)/settings/ Down the Road?
This could happen if the UX team decides to unify the navigation. For now, keeping them separate allows different chrome and navigation per audience.

