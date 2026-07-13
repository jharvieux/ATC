"use client";

// §39.7 / §40.5 — Tenant-side booking detail page.
//
// Layout: header (cruise line + ship + sailing date + status + total),
// then three tab panels that mount the existing editor components:
//   - Itinerary  → <ItineraryEditor> (drafts trip itinerary, sends to customer)
//   - Resources  → <ResourcesEditor> (trip resources page links + packing)
//   - Components → <LineItemsPanel>  (non-cruise line items: flights, hotels, etc.)
//
// All three panels accept a single booking_id prop and call their own
// backend APIs; this page is the mount point.

import { use, useEffect, useState } from "react";
import { ItineraryEditor } from "@/components/deliverables/ItineraryEditor";
import { ResourcesEditor } from "@/components/deliverables/ResourcesEditor";
import { LineItemsPanel } from "@/components/line-items/LineItemsPanel";

interface Booking {
  id: string;
  status: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  departure_port: string | null;
  total_amount: string | null;
  currency: string | null;
  host_adapter: string | null;
  host_booking_reference: string | null;
  is_test: boolean | null;
}

interface Contact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

type TabKey = "itinerary" | "resources" | "components";

const TABS: Array<{ key: TabKey; label: string; description: string }> = [
  { key: "itinerary", label: "Itinerary", description: "Trip-by-day plan the customer sees." },
  { key: "resources", label: "Resources", description: "Packing checklist + helpful links page." },
  { key: "components", label: "Components", description: "Flights, hotels, transfers, excursions, insurance." },
];

function money(amount: string | null, currency: string | null): string {
  if (amount === null) return "—";
  return `${currency ?? "USD"} ${amount}`;
}

function formatContact(c: Contact | null): string {
  if (!c) return "—";
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return name || c.email || "—";
}

export default function BookingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("itinerary");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<{ code: string; message: string } | null>(null);

  async function resolveReview() {
    if (!booking) return;
    setResolving(true);
    setResolveError(null);
    try {
      const res = await fetch(`/api/bookings/${booking.id}/resolve-review`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        error?: string;
        message?: string;
      };
      if (res.ok) {
        setBooking((prev) => (prev ? { ...prev, status: body.status ?? "draft" } : prev));
        return;
      }
      setResolveError({
        code: body.error ?? `status_${res.status}`,
        message: body.message ?? body.error ?? `Failed with status ${res.status}`,
      });
    } catch (e) {
      setResolveError({ code: "network_error", message: e instanceof Error ? e.message : "resolve_failed" });
    } finally {
      setResolving(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/bookings/${id}`);
        if (!res.ok) {
          const errBody = (await res.json().catch(() => ({}))) as { error?: string };
          setError(errBody.error ?? `status_${res.status}`);
          return;
        }
        const data = (await res.json()) as { booking: Booking; primary_contact: Contact | null };
        if (cancelled) return;
        setBooking(data.booking);
        setContact(data.primary_contact);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "load_failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loading) {
    return <div className="p-8 text-gray-500">Loading booking…</div>;
  }
  if (error || !booking) {
    return (
      <div className="p-8 max-w-3xl mx-auto">
        <h1 className="text-lg font-semibold text-red-700">Booking not available</h1>
        <p className="text-sm text-gray-600 mt-2">
          {error === "not_found"
            ? "We couldn't find that booking. It may have been deleted, or you may not have permission to view it."
            : `Failed to load: ${error ?? "unknown error"}`}
        </p>
      </div>
    );
  }

  const statusColor =
    booking.status === "draft"
      ? "bg-gray-100 text-gray-700"
      : booking.status === "submitting"
        ? "bg-amber-100 text-amber-800"
        : booking.status === "pending_host_review"
          ? "bg-amber-100 text-amber-800"
          : booking.status === "submitted" || booking.status === "confirmed"
            ? "bg-green-100 text-green-800"
            : booking.status === "cancelled" || booking.status === "failed"
              ? "bg-red-100 text-red-800"
              : "bg-gray-100 text-gray-700";

  return (
    <div className="max-w-5xl mx-auto p-6">
      <header className="mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              {booking.is_test && (
                <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-800">
                  Test booking
                </span>
              )}
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusColor} capitalize`}>
                {booking.status.replace(/_/g, " ")}
              </span>
              {booking.status === "pending_host_review" && (
                <button
                  type="button"
                  onClick={() => void resolveReview()}
                  disabled={resolving}
                  className="text-xs px-2 py-0.5 rounded border border-amber-300 text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                >
                  {resolving ? "Resolving…" : "Resolve for editing"}
                </button>
              )}
            </div>
            <h1 className="text-2xl font-semibold truncate">
              {booking.cruise_line ?? "Cruise"} {booking.ship_name ?? ""}
            </h1>
            <p className="text-sm text-gray-600 mt-1">
              {booking.sailing_date ?? "Sailing date TBD"} ·{" "}
              {booking.duration_nights ? `${booking.duration_nights} nights` : "duration TBD"} ·{" "}
              {booking.cabin_category ?? "cabin TBD"}
            </p>
          </div>
          <div className="text-right shrink-0">
            <div className="text-xs text-gray-500">Total</div>
            <div className="text-xl font-semibold">
              {money(booking.total_amount, booking.currency)}
            </div>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <Field label="Booking ID" value={booking.id} mono />
          <Field label="Customer" value={formatContact(contact)} />
          <Field label="Departure port" value={booking.departure_port ?? "—"} />
          <Field
            label="Host"
            value={
              booking.host_adapter
                ? booking.host_booking_reference
                  ? `${booking.host_adapter} (${booking.host_booking_reference})`
                  : booking.host_adapter
                : "Platform fallback"
            }
          />
        </dl>

        {resolveError && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
            <p className="font-medium">Could not resolve for editing</p>
            <p className="mt-1">{resolveError.message}</p>
            {resolveError.code === "host_booking_may_exist" && (
              <p className="mt-1">
                A host-side booking may already exist for this trip — do not re-submit it. Investigate
                the host reservation before taking further action.
              </p>
            )}
          </div>
        )}
      </header>

      <nav className="border-b border-gray-200 flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t.key
                ? "border-blue-600 text-blue-700"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
            aria-current={tab === t.key ? "page" : undefined}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <section className="mt-6">
        <p className="text-xs text-gray-500 mb-3">{TABS.find((t) => t.key === tab)?.description}</p>
        {tab === "itinerary" && <ItineraryEditor booking_id={booking.id} />}
        {tab === "resources" && <ResourcesEditor booking_id={booking.id} />}
        {tab === "components" && <LineItemsPanel booking_id={booking.id} />}
      </section>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={`mt-0.5 text-gray-900 ${mono ? "font-mono text-xs" : ""}`}>{value}</dd>
    </div>
  );
}
