// BP39 §39.2.4 / §39.7 — Edit itinerary; optionally send (transition
// draft→sent + regenerate PDF + dispatch email).

import { z } from "zod";
import { safeUrl } from "@atc/contracts";
import { assertPermission } from "@/lib/auth/assert-permission";
import { createServiceRoleClient } from "@/lib/db/service-role-client";
import { newAccessToken } from "@/lib/deliverables/token";
import { renderItineraryPdf, type ItineraryPdfData } from "@/lib/deliverables/itinerary-pdf";
import { writeAuditLog } from "@/lib/audit/write";
import { respondToAuthError } from "@/lib/auth/respond";
import { dbErrorResponse } from "@/lib/api/db-error-response";
import { MAX_BOOKING_LINE_ITEMS } from "@/lib/line-items/validate";

const PatchSchema = z.object({
  agent_notes: z.string().optional(),
  cover_image_url: safeUrl.optional(),
  day_overrides: z.array(z.unknown()).optional(),
  send: z.boolean().optional(),       // true → transition to 'sent' + regen PDF
  rotate_token: z.boolean().optional(), // true → mint new token
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { ctx, user } = await assertPermission(req, { resource: "bookings.itinerary", action: "update" });
    const { id } = await params;
    const svc = createServiceRoleClient();

    const body = await req.json();
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({ error: "invalid_body", details: parsed.error.issues }, { status: 400 });
    }

    // Load + tenant-scope check.
    const { data: row, error: loadErr } = await svc
      .from("trip_itineraries")
      .select("*, bookings!inner(tenant_id, cruise_line, ship_name, sailing_date, duration_nights, cabin_category, departure_port, primary_contact_id)")
      .eq("id", id)
      .maybeSingle();
    if (loadErr) return dbErrorResponse(loadErr);
    if (!row) return Response.json({ error: "not_found" }, { status: 404 });
    type LoadedRow = {
      id: string;
      tenant_id: string;
      booking_id: string;
      status: string;
      access_token: string;
      agent_notes: string | null;
      bookings:
        | {
            tenant_id: string;
            cruise_line: string | null;
            ship_name: string | null;
            sailing_date: string | null;
            duration_nights: number | null;
            cabin_category: string | null;
            departure_port: string | null;
            primary_contact_id: string | null;
          }
        | Array<{
            tenant_id: string;
            cruise_line: string | null;
            ship_name: string | null;
            sailing_date: string | null;
            duration_nights: number | null;
            cabin_category: string | null;
            departure_port: string | null;
            primary_contact_id: string | null;
          }>
        | null;
    };
    const r = row as LoadedRow;
    if (r.tenant_id !== ctx.tenant_id) return Response.json({ error: "forbidden" }, { status: 403 });

    // #732: reject control characters in agent_notes — the same pre-check used
    // for persona addendums. Protects against steganographic injection vectors
    // being stored and later interpolated into the system prompt verbatim.
    if (parsed.data.agent_notes !== undefined && parsed.data.agent_notes !== null) {
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200F\u202A-\u202E\u2060-\u2064]/.test(parsed.data.agent_notes)) {
        return Response.json({ error: "control_characters_disallowed" }, { status: 422 });
      }
    }

    const update: Record<string, unknown> = {
      ...(parsed.data.agent_notes !== undefined ? { agent_notes: parsed.data.agent_notes } : {}),
      ...(parsed.data.cover_image_url !== undefined ? { cover_image_url: parsed.data.cover_image_url } : {}),
      ...(parsed.data.day_overrides !== undefined ? { day_overrides: parsed.data.day_overrides } : {}),
      updated_at: new Date().toISOString(),
    };
    if (parsed.data.rotate_token) update.access_token = newAccessToken();

    // Send path: regen PDF + upload + status transition.
    if (parsed.data.send) {
      const booking = Array.isArray(r.bookings) ? r.bookings[0] : r.bookings;
      if (booking) {
        // Tenant display name + agent contact for the PDF.
        const { data: tenantRow } = await svc
          .from("tenants")
          .select("display_name")
          .eq("id", r.tenant_id)
          .maybeSingle();
        const { data: agentRow } = await svc
          .from("users")
          .select("first_name, last_name, email, phone")
          .eq("id", user.id)
          .maybeSingle();
        let primaryName: string | null = null;
        if (booking.primary_contact_id) {
          const { data: c } = await svc
            .from("contacts")
            .select("first_name, last_name")
            .eq("id", booking.primary_contact_id)
            .maybeSingle();
          if (c) {
            const cc = c as { first_name: string | null; last_name: string | null };
            primaryName = [cc.first_name, cc.last_name].filter(Boolean).join(" ") || null;
          }
        }

        // §40.6 — non-cruise line items for itinerary integration.
        // Soft-fail when BP40 table isn't on dev yet (env without #139 merged).
        // #1788 — bound to the shared per-booking cap; no other guard on this read.
        let lineItems: import("@/lib/deliverables/itinerary-pdf").ItineraryLineItem[] = [];
        const { data: liData, error: liErr } = await svc
          .from("booking_line_items")
          .select("id, item_type, description, supplier_name, start_date, end_date, include_in_itinerary")
          .eq("booking_id", r.booking_id)
          .limit(MAX_BOOKING_LINE_ITEMS);
        if (liErr && liErr.code !== "42P01") {
          console.warn("[itinerary-send] booking_line_items load failed:", liErr.message);
        } else if (liData) {
          type LiRow = {
            id: string;
            item_type: "flight" | "hotel" | "transfer" | "excursion" | "insurance" | "other";
            description: string;
            supplier_name: string | null;
            start_date: string | null;
            end_date: string | null;
            include_in_itinerary: boolean;
          };
          lineItems = (liData as LiRow[])
            .filter((it) => it.include_in_itinerary)
            .map((it) => ({
              id: it.id,
              item_type: it.item_type,
              description: it.description,
              supplier_name: it.supplier_name,
              start_date: it.start_date,
              end_date: it.end_date,
            }));
        }

        const pdfData: ItineraryPdfData = {
          tenant: { display_name: (tenantRow as { display_name?: string } | null)?.display_name ?? "" },
          cruise_line: booking.cruise_line,
          ship_name: booking.ship_name,
          sailing_date: booking.sailing_date,
          duration_nights: booking.duration_nights,
          cabin_category: booking.cabin_category,
          primary_passenger_name: primaryName,
          embarkation_port: booking.departure_port,
          agent_notes: (update.agent_notes as string | undefined) ?? r.agent_notes,
          agent: {
            name: agentRow
              ? [
                  (agentRow as { first_name: string | null }).first_name,
                  (agentRow as { last_name: string | null }).last_name,
                ]
                  .filter(Boolean)
                  .join(" ") || null
              : null,
            email: (agentRow as { email: string | null } | null)?.email ?? null,
            phone: (agentRow as { phone: string | null } | null)?.phone ?? null,
          },
          line_items: lineItems,
        };

        try {
          const pdfBuf = await renderItineraryPdf(pdfData);
          const path = `${r.tenant_id}/${r.id}.pdf`;
          const { error: upErr } = await svc.storage
            .from("trip-itinerary-pdfs")
            .upload(path, pdfBuf, { contentType: "application/pdf", upsert: true });
          if (upErr) {
            const ref = crypto.randomUUID();
            console.error("[itineraries] ref=%s pdf_upload_failed", ref, upErr);
            return Response.json({ error: "pdf_upload_failed", ref }, { status: 500 });
          }
          update.pdf_storage_key = path;
          update.last_pdf_generated_at = new Date().toISOString();
        } catch (err) {
          const ref = crypto.randomUUID();
          console.error("[itineraries] ref=%s pdf_render_failed", ref, err);
          return Response.json({ error: "pdf_render_failed", ref }, { status: 500 });
        }
      }

      update.status = "sent";
      update.sent_at = new Date().toISOString();

      // Email dispatch is the BP23 sendTemplatedEmail path; out of this PR's
      // scope, but flagged here for the wire-up step.
    }

    const { data, error } = await svc
      .from("trip_itineraries")
      .update(update)
      .eq("id", id)
      .eq("tenant_id", r.tenant_id)
      .select()
      .single();
    if (error) return dbErrorResponse(error);

    if (parsed.data.send) {
      await writeAuditLog({
        tenant_id: r.tenant_id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "itinerary.sent",
        resource_type: "trip_itinerary",
        resource_id: id,
      });
    }

    return Response.json(data);
  } catch (err) {
    return respondToAuthError(err);
  }
}
