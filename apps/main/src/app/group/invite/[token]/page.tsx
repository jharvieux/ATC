// §18.5 — Invitee canonical landing page.
// Validates the token server-side (five checks); renders group details,
// cabin grid, and RSVP buttons if valid.

import * as React from "react";

type PageProps = { params: Promise<{ token: string }> };

interface InviteData {
  invitation: { id: string; rsvp_state: string };
  group: {
    cruise_line: string;
    ship_name: string;
    sailing_date: string;
    departure_port: string;
    coordinator_message: string | null;
    hero_image_url: string | null;
    status: string;
  };
  cabin_grid: { booked: number; interested: number; pending: number; not_going: number };
}

async function fetchInviteData(token: string, origin: string): Promise<{ data?: InviteData; error?: string; reason?: string }> {
  const res = await fetch(`${origin}/api/groups/invite/${encodeURIComponent(token)}`, { cache: "no-store" });
  const body = await res.json() as InviteData & { error?: string; reason?: string };
  if (!res.ok) {
    const result: { data?: InviteData; error?: string; reason?: string } = { error: body.error ?? "unknown_error" };
    if (body.reason !== undefined) result.reason = body.reason;
    return result;
  }
  return { data: body };
}

export default async function InvitePage(props: PageProps): Promise<React.ReactElement> {
  const params = await props.params;
  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL
    ? (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")
    : "http://localhost:3000";

  const { data, error, reason } = await fetchInviteData(params.token, origin);

  if (error) {
    return (
      <main className="flex flex-col items-center justify-center min-h-screen gap-4 p-8">
        <h1 className="text-[22px] font-bold text-red-600 dark:text-red-400">Invitation unavailable</h1>
        <p className="text-muted-foreground max-w-[400px] text-center">
          {reason === "expired_natural"
            ? "This invitation has expired."
            : reason === "invitee_removed"
            ? "You have been removed from this trip invitation."
            : "This invitation link is invalid or has been revoked. Please contact the trip coordinator."}
        </p>
      </main>
    );
  }

  if (!data) return <main><p>Loading…</p></main>;

  const { group, invitation, cabin_grid } = data;
  const isSailed = group.status === "sailed";

  return (
    <main className="max-w-[680px] mx-auto px-4 py-8">
      {group.hero_image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        (<img src={group.hero_image_url} alt={group.departure_port} className="w-full rounded-xl mb-6 max-h-[300px] object-cover" />)
      )}
      <h1 className="text-[26px] font-bold mb-1">{group.cruise_line} — {group.ship_name}</h1>
      <p className="text-muted-foreground mb-6">
        Sailing {new Date(group.sailing_date).toLocaleDateString("en-US", { dateStyle: "long" })} · {group.departure_port}
      </p>
      {group.coordinator_message && (
        <blockquote className="mb-6 pl-5 border-l-4 border-primary bg-muted/40 py-4 pr-5 font-serif text-[15px] leading-[1.7]">
          {group.coordinator_message}
        </blockquote>
      )}
      <div className="grid grid-cols-3 gap-3 mb-8">
        <StatCard label="Booked" value={cabin_grid.booked} className="text-emerald-600 dark:text-emerald-400" />
        <StatCard label="Interested" value={cabin_grid.interested} className="text-amber-600 dark:text-amber-400" />
        <StatCard label="Pending" value={cabin_grid.pending} className="text-muted-foreground" />
      </div>
      {!isSailed && (
        <div className="mb-8">
          <h2 className="text-[16px] font-semibold mb-4">Your RSVP</h2>
          <RsvpButtons token={params.token} current={invitation.rsvp_state} />
        </div>
      )}
      {isSailed && (
        <p className="text-muted-foreground italic">This group has sailed — the page is now read-only.</p>
      )}
    </main>
  );
}

function StatCard(props: { label: string; value: number; className: string }): React.ReactElement {
  return (
    <div className="bg-muted rounded-lg p-4 text-center">
      <div className={`text-[28px] font-bold ${props.className}`}>{props.value}</div>
      <div className="text-[13px] text-muted-foreground">{props.label}</div>
    </div>
  );
}

function RsvpButtons(props: { token: string; current: string }): React.ReactElement {
  const options: { state: string; label: string }[] = [
    { state: "interested", label: "I'm interested" },
    { state: "not_going", label: "Can't make it" },
    { state: "booked", label: "I've booked" },
  ];
  return (
    <div className="flex gap-3 flex-wrap">
      {options.map((opt) => (
        <form key={opt.state} method="POST" action={`/api/groups/invite/${props.token}/rsvp`}>
          <input type="hidden" name="rsvp_state" value={opt.state} />
          <button
            type="submit"
            className={`px-5 py-2.5 rounded-lg text-[14px] transition-colors ${
              props.current === opt.state
                ? "border-2 border-primary bg-primary/10 font-bold"
                : "border border-border bg-card hover:bg-accent"
            }`}
          >
            {opt.label}
          </button>
        </form>
      ))}
    </div>
  );
}
