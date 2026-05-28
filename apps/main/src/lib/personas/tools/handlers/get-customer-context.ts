// §9.6 — get_customer_context handler.
//
// Reads contact basics + customer memories for the current customer.
// Tenant-scoped (every query filters by tenant_id). Read-only.

import { z } from "zod";
import type { ToolDispatchContext, ToolResult } from "../dispatch";

const InputSchema = z.object({
  include_bookings: z.boolean().optional().default(true),
  include_preferences: z.boolean().optional().default(true),
  include_memory: z.boolean().optional().default(true),
});

interface ContactSummary {
  id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
}

interface BookingSummary {
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  status: string;
}

interface MemoryRow {
  preferences: unknown;
  travel_history: unknown;
  family_composition: unknown;
  accessibility_needs: unknown;
  updated_at?: string;
}

export async function getCustomerContext(
  rawInput: Record<string, unknown>,
  dispatchCtx: ToolDispatchContext,
): Promise<ToolResult> {
  const parsed = InputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      content: JSON.stringify({ error: "invalid_input", detail: parsed.error.message }),
      was_mutating: false,
    };
  }
  const { include_bookings, include_preferences, include_memory } = parsed.data;

  if (!dispatchCtx.contact_id) {
    return {
      content: JSON.stringify({
        error: "no_customer_in_session",
        message:
          "No customer is identified for this conversation. Ask the user for their name or email to look them up.",
      }),
      was_mutating: false,
    };
  }

  const { db, ctx } = dispatchCtx;
  const tenant_id = ctx.tenant_id;

  // Contact basics
  const { data: contactData, error: contactErr } = await db
    .from("contacts")
    .select("id, first_name, last_name, email, phone")
    .eq("id", dispatchCtx.contact_id)
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (contactErr || !contactData) {
    return {
      content: JSON.stringify({
        error: "contact_not_found",
        detail: contactErr?.message ?? "no row",
      }),
      was_mutating: false,
    };
  }
  const c = contactData as { id: string; first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null };
  const contact: ContactSummary = {
    id: c.id,
    display_name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || c.email || "(unknown)",
    email: c.email ?? null,
    phone: c.phone ?? null,
  };

  // Past bookings (only if asked)
  let bookings: BookingSummary[] = [];
  if (include_bookings) {
    const { data: bookingRows } = await db
      .from("bookings")
      .select("cruise_line, ship_name, sailing_date, status")
      .eq("tenant_id", tenant_id)
      .eq("primary_contact_id", dispatchCtx.contact_id)
      .order("sailing_date", { ascending: false })
      .limit(10);
    bookings = ((bookingRows ?? []) as BookingSummary[]);
  }

  // Customer memories (preferences + family + accessibility — only if asked)
  let memory: MemoryRow | null = null;
  if (include_memory || include_preferences) {
    const { data: memRow } = await db
      .from("customer_memories")
      .select("preferences, travel_history, family_composition, accessibility_needs, updated_at")
      .eq("tenant_id", tenant_id)
      .eq("contact_id", dispatchCtx.contact_id)
      .maybeSingle();
    memory = (memRow ?? null) as MemoryRow | null;
  }

  return {
    content: JSON.stringify({
      contact,
      booking_count: bookings.length,
      ...(include_bookings ? { recent_bookings: bookings } : {}),
      ...(memory ? { memory } : { memory: null }),
    }),
    was_mutating: false,
  };
}
