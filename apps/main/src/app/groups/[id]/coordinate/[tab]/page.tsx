// §18.11 — Coordinator portal tab pages.
//
// Each tab renders a distinct panel:
//   overview   — group stats, upcoming actions, cabin grid summary
//   invitees   — invitee table with RSVP state and mute/remove actions
//   edit       — group detail edit form (read-only if group.status = 'sailed')
//   preview-email — renders the GroupInvitation email template with live group data
//   forum      — embedded forum view with coordinator privileges enabled
//
// Restyled per specs/design_handoff_group_landing/ "Bright & Vacation-y"
// identity (CoordinatorShell supplies the [data-cruise-theme] + quicksand
// font ancestor — these server-rendered panels just reference the
// --cruise-* CSS vars). Shadcn form controls (Button/Input/Label/Textarea)
// are dropped in favor of raw elements styled with cruise tokens, since
// those components hardcode the app-wide indigo/Geist theme (--primary,
// border-input) which would fight this fixed identity — same reasoning
// the invite-landing page used to avoid <TenantTheme/> here.

import * as React from "react";
import { GroupBroadcast } from "@/emails/GroupBroadcast";
import { BroadcastComposerClient } from "@/components/groups/BroadcastComposerClient";
import { InviteesTabClient } from "@/components/groups/InviteesTabClient";
import { ForumTabClient } from "@/components/groups/ForumTabClient";
import { DeleteGroupClient } from "@/components/groups/DeleteGroupClient";

const VALID_TABS = ["overview", "invitees", "edit", "preview-email", "forum"] as const;
type Tab = (typeof VALID_TABS)[number];

const CARD = "rounded-[var(--cruise-radius-card)] bg-[var(--cruise-surface)] p-6 shadow-[var(--cruise-card-shadow)]";
const HEADING = "font-[family-name:var(--font-quicksand)] text-xl font-bold text-[var(--cruise-text)]";
const LABEL = "text-sm font-semibold text-[var(--cruise-text)]";
const INPUT =
  "h-10 w-full rounded-[var(--cruise-radius-itinerary)] border border-[var(--cruise-border)] bg-[var(--cruise-bg)] px-3 text-sm text-[var(--cruise-text)] placeholder:text-[var(--cruise-text-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cruise-accent)]";
const BUTTON_PRIMARY =
  "rounded-[var(--cruise-radius-pill)] bg-[var(--cruise-accent)] px-5 py-2.5 font-[family-name:var(--font-quicksand)] text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-60";

type PageProps = {
  params: Promise<{ id: string; tab: string }>;
};

export default async function CoordinateTabPage({
  params,
}: PageProps): Promise<React.ReactElement> {
  const { id, tab } = await params;

  if (!VALID_TABS.includes(tab as Tab)) {
    return (
      <div className="text-[var(--cruise-coral)]">
        <p>Unknown tab: <strong>{tab}</strong>. Valid tabs: {VALID_TABS.join(", ")}.</p>
      </div>
    );
  }

  return <TabContent groupId={id} tab={tab as Tab} />;
}

function TabContent({ groupId, tab }: { groupId: string; tab: Tab }): React.ReactElement {
  switch (tab) {
    case "overview":
      return <OverviewTab groupId={groupId} />;
    case "invitees":
      return <InviteesTab groupId={groupId} />;
    case "edit":
      return <EditTab groupId={groupId} />;
    case "preview-email":
      return <PreviewEmailTab groupId={groupId} />;
    case "forum":
      return <ForumTab groupId={groupId} />;
  }
}

function OverviewTab({ groupId }: { groupId: string }): React.ReactElement {
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className={HEADING}>Overview</h2>
        <p className="mt-1 text-sm font-medium text-[var(--cruise-text-muted)]">Group ID: {groupId}</p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Booked" value="—" colorClass="text-[var(--cruise-success)]" />
        <StatCard label="Interested" value="—" colorClass="text-[#e8a017]" />
        <StatCard label="Not going" value="—" colorClass="text-[var(--cruise-text-muted)]" />
      </div>

      <div className={CARD}>
        <h3 className="font-[family-name:var(--font-quicksand)] text-sm font-bold text-[var(--cruise-text)]">Quick actions</h3>
        <ul className="m-0 mt-3 flex list-none flex-col gap-2 p-0">
          <li>
            <a href={`/groups/${groupId}/coordinate/invitees`} className="text-sm font-medium text-[var(--cruise-accent)] no-underline hover:underline">
              → Manage invitees
            </a>
          </li>
          <li>
            <a href={`/groups/${groupId}/coordinate/preview-email`} className="text-sm font-medium text-[var(--cruise-accent)] no-underline hover:underline">
              → Preview invitation email
            </a>
          </li>
          <li>
            <a href={`/groups/${groupId}/coordinate/forum`} className="text-sm font-medium text-[var(--cruise-accent)] no-underline hover:underline">
              → Open group forum
            </a>
          </li>
        </ul>
      </div>
    </section>
  );
}

function InviteesTab({ groupId }: { groupId: string }): React.ReactElement {
  // TODO(BP19/§18): full invitee management (mute via forum user state API)
  return <InviteesTabClient groupId={groupId} />;
}

function EditTab({ groupId }: { groupId: string }): React.ReactElement {
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className={HEADING}>Edit Group</h2>
        <p className="mt-1 text-sm font-medium text-[var(--cruise-text-muted)]">
          Edit group details. Fields are read-only after the group&apos;s sailing date has passed.
        </p>
      </div>

      <div className={CARD}>
        {/* §18.10 sailed read-only enforcement is checked at the API level in PATCH /api/groups/:id */}
        <form className="flex flex-col gap-4">
          <FormField label="Cruise Line" name="cruise_line" />
          <FormField label="Ship Name" name="ship_name" />
          <FormField label="Sailing Date" name="sailing_date" type="date" />
          <FormField label="Departure Port" name="departure_port" />
          <div className="flex flex-col gap-1">
            <label htmlFor="coordinator_message" className={LABEL}>Coordinator Message</label>
            <textarea
              id="coordinator_message"
              name="coordinator_message"
              rows={4}
              placeholder="Optional message shown on the invitation page…"
              className={`${INPUT} min-h-[100px] resize-none py-2`}
            />
          </div>
          <div>
            <button type="submit" className={BUTTON_PRIMARY}>Save Changes</button>
          </div>
        </form>
      </div>

      <DeleteGroupClient groupId={groupId} />
    </section>
  );
}

function PreviewEmailTab({ groupId }: { groupId: string }): React.ReactElement {
  return (
    <div className="flex flex-col gap-8">
      <BroadcastComposerClient groupId={groupId} />

      <section>
        <h2 className={HEADING}>Email preview</h2>
        <p className="mt-1 mb-4 text-sm font-medium text-[var(--cruise-text-muted)]">
          Layout your invitees will see (placeholder content).
        </p>
        {/* Same GroupBroadcast template the live send renders. Intentionally
            renders as an actual email would, not restyled to the cruise
            theme — this preview's whole purpose is showing the real output. */}
        <div className="overflow-hidden rounded-[var(--cruise-radius-card)] border border-[var(--cruise-border)] shadow-[var(--cruise-card-shadow)]">
          <GroupBroadcast
            branding={{}}
            tenant_legal_name="[Your Agency]"
            tenant_business_address="[Your mailing address]"
            unsubscribe_url="/settings/notifications"
            subject="You're invited to a group cruise!"
            message={
              "[Coordinator message will appear here]\n\nReply to this email or " +
              "use the link in your invitation to RSVP."
            }
            group_name="[Cruise Line] — [Ship Name]"
          />
        </div>
      </section>
    </div>
  );
}

function ForumTab({ groupId }: { groupId: string }): React.ReactElement {
  return (
    <section className="flex flex-col gap-4">
      <h2 className={HEADING}>Group Forum</h2>
      <ForumTabClient groupId={groupId} />
    </section>
  );
}

function StatCard({ label, value, colorClass }: { label: string; value: string | number; colorClass?: string }): React.ReactElement {
  return (
    <div className="rounded-[var(--cruise-radius-card)] bg-[var(--cruise-surface)] p-[22px] text-center shadow-[var(--cruise-card-shadow)]">
      <div className={`font-[family-name:var(--font-quicksand)] text-[28px] font-bold ${colorClass ?? ""}`}>{value}</div>
      <div className="mt-1 text-[13px] font-semibold text-[var(--cruise-text-muted)]">{label}</div>
    </div>
  );
}

function FormField({
  label,
  name,
  type = "text",
}: {
  label: string;
  name: string;
  type?: string;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className={LABEL}>{label}</label>
      <input id={name} type={type} name={name} className={INPUT} />
    </div>
  );
}
