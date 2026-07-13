"use client";

import * as React from "react";
import { useCruiseTheme } from "@/lib/group-invite/use-cruise-theme";
import { quicksand } from "@/lib/fonts/quicksand";
import { Nav } from "./Nav";
import { Hero } from "./Hero";
import { CoordinatorMessage } from "./CoordinatorMessage";
import { StatsAndSocialProof } from "./StatsAndSocialProof";
import { ShipSection } from "./ShipSection";
import { ItinerarySection } from "./ItinerarySection";
import { ChatPreviewCard } from "./ChatPreviewCard";
import { RsvpSection } from "./RsvpSection";
import { GuestListModal } from "./GuestListModal";
import type { CabinGrid, InviteData } from "./types";

// Real DB rsvp_state (pending|interested|not_going|booked) maps directly to
// the button/stat states here — no translation needed, unlike the design
// file's illustrative 'booked'|'interested'|'cant'|null enum.
type RsvpButtonState = "interested" | "not_going" | "booked";

export function GroupInviteView({ data, token, tenantLogoUrl = null }: { data: InviteData; token: string; tenantLogoUrl?: string | null }) {
  const [theme] = useCruiseTheme();
  const [rsvpState, setRsvpState] = React.useState(data.invitation.rsvp_state);
  const [isAnonymous, setIsAnonymous] = React.useState(data.invitation.visibility_choice === "be_anonymous");
  const [cabinGrid, setCabinGrid] = React.useState<CabinGrid>(data.cabin_grid);
  const [pending, setPending] = React.useState(false);
  const [guestListOpen, setGuestListOpen] = React.useState(false);

  const isSailed = data.group.status === "sailed";
  // sailing_date is a date-only string parsed as UTC midnight (#1808) — use
  // UTC getters so negative-UTC-offset locales don't shift the year back.
  const sailingYear = new Date(data.group.sailing_date).getUTCFullYear();
  const nights = data.itinerary ? data.itinerary.length - 1 : 0;

  async function patchInvitation(body: Record<string, string>) {
    const res = await fetch(`/api/groups/invite/${encodeURIComponent(token)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("patch_failed");
  }

  async function handleRsvpChange(next: RsvpButtonState) {
    if (pending || next === rsvpState) return;
    const prevState = rsvpState;
    setPending(true);
    setRsvpState(next);
    setCabinGrid((prev) => ({
      ...prev,
      [prevState]: Math.max(0, (prev[prevState as keyof CabinGrid] ?? 0) - 1),
      [next]: (prev[next] ?? 0) + 1,
    }));
    try {
      await patchInvitation({ rsvp_state: next });
    } catch {
      setRsvpState(prevState);
      // Undo the exact delta relative to current state, not the stale
      // mount-time data.cabin_grid — otherwise reverting a second failed
      // change would also wipe out any earlier successful one.
      setCabinGrid((prev) => ({
        ...prev,
        [prevState]: (prev[prevState as keyof CabinGrid] ?? 0) + 1,
        [next]: Math.max(0, (prev[next] ?? 0) - 1),
      }));
    } finally {
      setPending(false);
    }
  }

  async function handleAnonymousChange(next: boolean) {
    if (pending) return;
    const prev = isAnonymous;
    setPending(true);
    setIsAnonymous(next);
    try {
      await patchInvitation({ visibility_choice: next ? "be_anonymous" : "no_opinion" });
    } catch {
      setIsAnonymous(prev);
    } finally {
      setPending(false);
    }
  }

  return (
    <div data-cruise-theme={theme} className={`${quicksand.variable} min-h-screen bg-[var(--cruise-bg)] text-[var(--cruise-text)]`}>
      <Nav
        cruiseLine={data.group.cruise_line}
        sailingYear={sailingYear}
        organizers={data.roster.filter((r) => !r.anonymous).slice(0, 2)}
        tenantLogoUrl={tenantLogoUrl}
      />
      <Hero
        theme={theme}
        shipName={data.group.ship_name}
        nights={nights}
        departurePort={data.group.departure_port}
        sailingDate={data.group.sailing_date}
        itinerary={data.itinerary}
      />
      <CoordinatorMessage message={data.group.coordinator_message} />
      <StatsAndSocialProof cabinGrid={cabinGrid} roster={data.roster} onOpenGuestList={() => setGuestListOpen(true)} />
      <ShipSection shipName={data.group.ship_name} heroImageUrl={data.group.hero_image_url} shipStats={data.ship_stats} />
      <ItinerarySection itinerary={data.itinerary} />
      <ChatPreviewCard chatPreview={data.chat_preview} chatHref={`/group/invite/${encodeURIComponent(token)}/chat`} />
      <RsvpSection
        rsvpState={rsvpState}
        isAnonymous={isAnonymous}
        isSailed={isSailed}
        pending={pending}
        onRsvpChange={handleRsvpChange}
        onAnonymousChange={handleAnonymousChange}
      />
      {guestListOpen ? <GuestListModal roster={data.roster} onClose={() => setGuestListOpen(false)} /> : null}
    </div>
  );
}
