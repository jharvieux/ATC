// §18.11 — Coordinator portal tab pages.
//
// Each tab renders a distinct panel:
//   overview   — group stats, upcoming actions, cabin grid summary
//   invitees   — invitee table with RSVP state and mute/remove actions
//   edit       — group detail edit form (read-only if group.status = 'sailed')
//   preview-email — renders the GroupInvitation email template with live group data
//   forum      — embedded forum view with coordinator privileges enabled

import * as React from "react";
import { GroupBroadcast } from "@/emails/GroupBroadcast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { BroadcastComposerClient } from "@/components/groups/BroadcastComposerClient";
import { InviteesTabClient } from "@/components/groups/InviteesTabClient";
import { ForumTabClient } from "@/components/groups/ForumTabClient";

const VALID_TABS = ["overview", "invitees", "edit", "preview-email", "forum"] as const;
type Tab = (typeof VALID_TABS)[number];

type PageProps = {
  params: Promise<{ id: string; tab: string }>;
};

export default async function CoordinateTabPage({
  params,
}: PageProps): Promise<React.ReactElement> {
  const { id, tab } = await params;

  if (!VALID_TABS.includes(tab as Tab)) {
    return (
      <div className="text-red-600">
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
    <section>
      <h2 className="text-[18px] font-bold mb-4">Overview</h2>
      <p className="text-muted-foreground mb-6">Group ID: {groupId}</p>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Booked" value="—" valueClass="text-emerald-600" />
        <StatCard label="Interested" value="—" valueClass="text-amber-600" />
        <StatCard label="Not going" value="—" valueClass="text-muted-foreground" />
      </div>

      <div className="mt-6 p-4 bg-muted rounded-lg">
        <h3 className="text-[14px] font-semibold mb-2">Quick actions</h3>
        <ul className="list-none p-0 m-0 flex flex-col gap-2">
          <li>
            <a href={`/groups/${groupId}/coordinate/invitees`} className="text-primary no-underline text-[14px]">
              → Manage invitees
            </a>
          </li>
          <li>
            <a href={`/groups/${groupId}/coordinate/preview-email`} className="text-primary no-underline text-[14px]">
              → Preview invitation email
            </a>
          </li>
          <li>
            <a href={`/groups/${groupId}/coordinate/forum`} className="text-primary no-underline text-[14px]">
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

function EditTab({ groupId: _groupId }: { groupId: string }): React.ReactElement {
  return (
    <section>
      <h2 className="text-[18px] font-bold mb-4">Edit Group</h2>
      <p className="text-muted-foreground mb-6 text-[14px]">
        Edit group details. Fields are read-only after the group&apos;s sailing date has passed.
      </p>

      {/* §18.10 sailed read-only enforcement is checked at the API level in PATCH /api/groups/:id */}
      <form className="flex flex-col gap-4">
        <FormField label="Cruise Line" name="cruise_line" />
        <FormField label="Ship Name" name="ship_name" />
        <FormField label="Sailing Date" name="sailing_date" type="date" />
        <FormField label="Departure Port" name="departure_port" />
        <div className="flex flex-col gap-1">
          <Label htmlFor="coordinator_message">Coordinator Message</Label>
          <Textarea
            id="coordinator_message"
            name="coordinator_message"
            rows={4}
            placeholder="Optional message shown on the invitation page…"
          />
        </div>
        <div>
          <Button type="submit">Save Changes</Button>
        </div>
      </form>
    </section>
  );
}

function PreviewEmailTab({ groupId }: { groupId: string }): React.ReactElement {
  return (
    <div className="flex flex-col gap-10">
      <BroadcastComposerClient groupId={groupId} />

      <section>
        <h2 className="text-[18px] font-bold mb-2">Email preview</h2>
        <p className="text-muted-foreground mb-4 text-[14px]">
          Layout your invitees will see (placeholder content).
        </p>
        {/* Same GroupBroadcast template the live send renders. */}
        <div className="border border-border rounded-lg bg-muted overflow-hidden">
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
    <section>
      <h2 className="text-[18px] font-bold mb-4">Group Forum</h2>
      <ForumTabClient groupId={groupId} />
    </section>
  );
}

function StatCard({ label, value, valueClass }: { label: string; value: string | number; valueClass?: string }): React.ReactElement {
  return (
    <div className="bg-muted rounded-lg p-4 text-center">
      <div className={`text-[28px] font-bold ${valueClass ?? ""}`}>{value}</div>
      <div className="text-[13px] text-muted-foreground">{label}</div>
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
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} type={type} name={name} />
    </div>
  );
}
