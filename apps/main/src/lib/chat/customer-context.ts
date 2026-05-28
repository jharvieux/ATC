// §20.4 / §38.8.1 / §39.5 — Customer-context resolver for /api/chat.
//
// Builds the `customer_context` string that gets injected into the
// system prompt (see buildSystemPrompt's `customer_context` arg) so the
// AI knows which booking / quote / itinerary the customer is asking
// about. Server-side ONLY: the client passes a ref `{type, id}` and the
// server fetches + validates ownership before formatting. This stops a
// client from injecting arbitrary text into the system prompt.
//
// Tenant scoping: every lookup is filtered by `tenantId` (the resolved
// tenant from middleware) so a token / cookie scoped to tenant A can
// never read a booking belonging to tenant B.

import type { SupabaseClient } from "@supabase/supabase-js";

export type CustomerContextRef =
  | { type: "booking"; id: string }
  | { type: "trip_itinerary"; id: string }
  | { type: "quote"; id: string };

export interface ResolveContextArgs {
  ref: CustomerContextRef;
  tenant_id: string;
  /** Service-role client. Caller is responsible for any user-level auth gating. */
  db: SupabaseClient;
}

interface BookingContextRow {
  id: string;
  tenant_id: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  departure_port: string | null;
  total_amount_cents: number | bigint | null;
  currency: string | null;
  status: string | null;
}

interface QuoteContextRow {
  id: string;
  tenant_id: string;
  status: string | null;
  expires_at: string | null;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  total_price_cents: number | bigint | null;
  currency: string | null;
}

interface ItineraryContextRow {
  id: string;
  tenant_id: string;
  booking_id: string;
  agent_notes: string | null;
}

function fmtMoney(amount: number | bigint | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  const cents = typeof amount === "bigint" ? Number(amount) : amount;
  const cur = currency ?? "USD";
  return `${cur} ${(cents / 100).toFixed(2)}`;
}

function fmtNumberOrDash(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : String(n);
}

function fmtStrOrDash(s: string | null | undefined): string {
  if (!s) return "—";
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : "—";
}

/**
 * Resolve a customer-context ref to a system-prompt-ready context string.
 * Returns `null` if the resource doesn't exist or doesn't belong to the
 * tenant — callers should treat null as "no context to inject."
 */
export async function resolveCustomerContext(args: ResolveContextArgs): Promise<string | null> {
  const { ref, tenant_id, db } = args;

  if (ref.type === "booking") {
    const { data, error } = await db
      .from("bookings")
      .select(
        "id, tenant_id, cruise_line, ship_name, sailing_date, duration_nights, cabin_category, departure_port, total_amount_cents, currency, status",
      )
      .eq("id", ref.id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (error) {
      console.warn("[customer-context] booking lookup failed:", error.message);
      return null;
    }
    if (!data) return null;
    const b = data as BookingContextRow;
    return [
      "The customer is currently working on a cruise booking. Use these details when relevant:",
      `- Cruise line: ${fmtStrOrDash(b.cruise_line)}`,
      `- Ship: ${fmtStrOrDash(b.ship_name)}`,
      `- Sailing date: ${fmtStrOrDash(b.sailing_date)}`,
      `- Duration: ${fmtNumberOrDash(b.duration_nights)} nights`,
      `- Cabin: ${fmtStrOrDash(b.cabin_category)}`,
      `- Departure port: ${fmtStrOrDash(b.departure_port)}`,
      `- Total: ${fmtMoney(b.total_amount_cents, b.currency)}`,
      `- Booking status: ${fmtStrOrDash(b.status)}`,
      "",
      "Do NOT promise prices or quote new pricing — direct the customer to their human agent for anything that changes the total.",
    ].join("\n");
  }

  if (ref.type === "quote") {
    const { data, error } = await db
      .from("quotes")
      .select(
        "id, tenant_id, status, expires_at, cruise_line, ship_name, sailing_date, duration_nights, total_price_cents, currency",
      )
      .eq("id", ref.id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (error) {
      console.warn("[customer-context] quote lookup failed:", error.message);
      return null;
    }
    if (!data) return null;
    const q = data as QuoteContextRow;
    return [
      "The customer is currently reviewing a cruise quote. Use these details when relevant:",
      `- Cruise line: ${fmtStrOrDash(q.cruise_line)}`,
      `- Ship: ${fmtStrOrDash(q.ship_name)}`,
      `- Sailing date: ${fmtStrOrDash(q.sailing_date)}`,
      `- Duration: ${fmtNumberOrDash(q.duration_nights)} nights`,
      `- Quoted price: ${fmtMoney(q.total_price_cents, q.currency)}`,
      `- Quote status: ${fmtStrOrDash(q.status)}`,
      `- Quote expires: ${fmtStrOrDash(q.expires_at)}`,
      "",
      "If the customer asks to accept, modify, or hold the quote, walk them through the on-page actions — do NOT attempt to change the price.",
    ].join("\n");
  }

  if (ref.type === "trip_itinerary") {
    const { data, error } = await db
      .from("trip_itineraries")
      .select("id, tenant_id, booking_id, agent_notes")
      .eq("id", ref.id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (error) {
      console.warn("[customer-context] itinerary lookup failed:", error.message);
      return null;
    }
    if (!data) return null;
    const it = data as ItineraryContextRow;

    const { data: bookingData } = await db
      .from("bookings")
      .select("cruise_line, ship_name, sailing_date, duration_nights, departure_port")
      .eq("id", it.booking_id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    const b = (bookingData ?? {}) as Partial<BookingContextRow>;

    return [
      "The customer is viewing their trip itinerary. Use these details when relevant:",
      `- Cruise line: ${fmtStrOrDash(b.cruise_line)}`,
      `- Ship: ${fmtStrOrDash(b.ship_name)}`,
      `- Sailing date: ${fmtStrOrDash(b.sailing_date)}`,
      `- Duration: ${fmtNumberOrDash(b.duration_nights ?? null)} nights`,
      `- Departure port: ${fmtStrOrDash(b.departure_port)}`,
      it.agent_notes ? `- Agent notes: ${it.agent_notes}` : "- Agent notes: (none)",
      "",
      "The trip is already booked. Help with packing tips, port info, and pre-cruise questions. For changes to the booking itself, refer them to their agent.",
    ].join("\n");
  }

  return null;
}
