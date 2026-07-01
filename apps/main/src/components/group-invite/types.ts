// Shared shape for the group invite-landing page, matching the GET
// /api/groups/invite/[token] response (apps/main/src/app/api/groups/invite/[token]/route.ts).

export interface RosterEntry {
  id: string;
  displayName: string;
  anonymous: boolean;
  avatarColor: string;
  status: "booked" | "interested" | "pending" | "not_going";
}

export interface ItineraryStop {
  dayLabel: string;
  portName: string;
  arrival: string | null;
  departure: string | null;
  isSeaDay: boolean;
}

export interface ShipStats {
  guestCapacity: number | null;
  decks: number | null;
  builtYear: number | null;
  signatureFeature: string | null;
}

export interface ChatMessagePreview {
  id: string;
  authorName: string;
  text: string;
  timestamp: string;
}

export interface ChatPreview {
  messages: ChatMessagePreview[];
  totalThisWeek: number;
}

export interface CabinGrid {
  booked: number;
  interested: number;
  pending: number;
  not_going: number;
}

export interface InviteGroup {
  id: string;
  status: string;
  cruise_line: string;
  ship_name: string;
  sailing_date: string;
  departure_port: string;
  coordinator_message: string | null;
  hero_image_url: string | null;
}

export interface InviteData {
  invitation: { id: string; rsvp_state: string; visibility_choice: string };
  group: InviteGroup;
  cabin_grid: CabinGrid;
  roster: RosterEntry[];
  itinerary: ItineraryStop[] | null;
  ship_stats: ShipStats | null;
  chat_preview: ChatPreview | null;
}
