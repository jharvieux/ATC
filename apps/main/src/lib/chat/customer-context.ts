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
import { formatCents } from "@/lib/money";
import { selectRepresentativeOption } from "@/lib/quotes/representative-option";

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
  valid_until: string | null;
  locked_price_cents: number | bigint | null;
  estimate_price_cents: number | bigint | null;
}

// §38.4.3 selection fields + the trip/price the customer context surfaces.
interface QuoteOptionContextRow {
  option_index: number;
  customer_selected: boolean | null;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  total_amount_cents: number | bigint | null;
  currency: string | null;
}

interface ItineraryContextRow {
  id: string;
  tenant_id: string;
  booking_id: string;
  agent_notes: string | null;
}

function fmtMoney(amount: number | bigint | null | undefined, currency: string | null | undefined): string {
  return formatCents(amount, currency ?? "USD");
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
      .select("id, tenant_id, status, valid_until, locked_price_cents, estimate_price_cents")
      .eq("id", ref.id)
      .eq("tenant_id", tenant_id)
      .maybeSingle();
    if (error) {
      console.warn("[customer-context] quote lookup failed:", error.message);
      return null;
    }
    if (!data) return null;
    const q = data as QuoteContextRow;

    // §38 — trip detail + per-option price live on quote_options. Service-role
    // client here, so scope by BOTH tenant_id and quote_id (D-091 two-layer)
    // and surface the representative option (customer-selected, else lowest).
    const { data: optionRows, error: optionsErr } = await db
      .from("quote_options")
      .select(
        "option_index, customer_selected, cruise_line, ship_name, sailing_date, duration_nights, total_amount_cents, currency",
      )
      .eq("quote_id", ref.id)
      .eq("tenant_id", tenant_id)
      .order("option_index", { ascending: true });
    if (optionsErr) {
      console.warn("[customer-context] quote_options lookup failed:", optionsErr.message);
      return null;
    }
    const opt = selectRepresentativeOption((optionRows ?? []) as QuoteOptionContextRow[]);

    // Container price wins (locked > estimate); fall back to the option total.
    const priceCents = q.locked_price_cents ?? q.estimate_price_cents ?? opt?.total_amount_cents ?? null;
    return [
      "The customer is currently reviewing a cruise quote. Use these details when relevant:",
      `- Cruise line: ${fmtStrOrDash(opt?.cruise_line)}`,
      `- Ship: ${fmtStrOrDash(opt?.ship_name)}`,
      `- Sailing date: ${fmtStrOrDash(opt?.sailing_date)}`,
      `- Duration: ${fmtNumberOrDash(opt?.duration_nights ?? null)} nights`,
      `- Quoted price: ${fmtMoney(priceCents, opt?.currency)}`,
      `- Quote status: ${fmtStrOrDash(q.status)}`,
      `- Quote expires: ${fmtStrOrDash(q.valid_until)}`,
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
      // #732: delimiters prevent injected instructions in agent_notes from
      // bleeding into the surrounding system-prompt structure.
      it.agent_notes
        ? `- Agent notes:\n  <<AGENT_NOTE_START>>\n  ${it.agent_notes.replace(/\n/g, "\n  ")}\n  <<AGENT_NOTE_END>>`
        : "- Agent notes: (none)",
      "",
      "The trip is already booked. Help with packing tips, port info, and pre-cruise questions. For changes to the booking itself, refer them to their agent.",
    ].join("\n");
  }

  return null;
}
