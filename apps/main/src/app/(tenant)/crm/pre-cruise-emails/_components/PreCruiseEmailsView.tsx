"use client";

import { useEffect, useState } from "react";

interface Contact {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

interface Booking {
  id: string;
  status: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  primary_contact: Contact | null;
}

type Phase = "t_90" | "t_30" | "t_7" | "t_1";
type Delivery = "send_now" | "schedule";

const PHASES: ReadonlyArray<{
  value: Phase;
  timing: string;
  title: string;
  description: string;
}> = [
  {
    value: "t_90",
    timing: "90 days",
    title: "Build anticipation",
    description: "Documents, destination highlights, and must-do experiences.",
  },
  {
    value: "t_30",
    timing: "30 days",
    title: "Final preparation",
    description: "Check-in, reservations, recommendations, and packing inspiration.",
  },
  {
    value: "t_7",
    timing: "7 days",
    title: "Almost there",
    description: "Packing checklist, ship highlights, weather, and embarkation advice.",
  },
  {
    value: "t_1",
    timing: "1 day",
    title: "Tomorrow is the day",
    description: "Carry-on essentials, port guidance, forecast, and day-one details.",
  },
];

const ERROR_MESSAGES: Record<string, string> = {
  booking_not_confirmed: "Only confirmed bookings can receive pre-cruise emails.",
  booking_not_found: "That booking is no longer available.",
  dispatch_unavailable: "Email scheduling is temporarily unavailable. Please try again.",
  invalid_schedule_time: "Choose a time at least one minute from now and within the next year.",
  phase_already_sent: "That email has already been sent for this booking.",
  recipient_missing: "Add an email address to the booking's primary contact first.",
  sailing_date_missing: "Add a sailing date to this booking first.",
};

function bookingLabel(booking: Booking): string {
  const contactName = [booking.primary_contact?.first_name, booking.primary_contact?.last_name]
    .filter(Boolean)
    .join(" ");
  const traveler = contactName || booking.primary_contact?.email || "Traveler";
  const trip = [booking.cruise_line, booking.ship_name].filter(Boolean).join(" · ") || "Cruise";
  return `${traveler} — ${trip} — ${booking.sailing_date ?? "date TBD"}`;
}

export function PreCruiseEmailsView() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [query, setQuery] = useState("");
  const [bookingId, setBookingId] = useState("");
  const [phase, setPhase] = useState<Phase>("t_90");
  const [delivery, setDelivery] = useState<Delivery>("send_now");
  const [scheduleAt, setScheduleAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [minScheduleValue, setMinScheduleValue] = useState("");

  useEffect(() => {
    const minSchedule = new Date(Date.now() + 5 * 60_000);
    minSchedule.setSeconds(0, 0);
    setMinScheduleValue(
      `${minSchedule.getFullYear()}-${String(minSchedule.getMonth() + 1).padStart(2, "0")}-${String(minSchedule.getDate()).padStart(2, "0")}T${String(minSchedule.getHours()).padStart(2, "0")}:${String(minSchedule.getMinutes()).padStart(2, "0")}`,
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void (async () => {
        setLoading(true);
        setError(null);
        try {
          const url = new URL("/api/bookings", window.location.origin);
          url.searchParams.set("status", "confirmed");
          url.searchParams.set("page_size", "100");
          if (query.trim().length >= 2) url.searchParams.set("contact_query", query.trim());
          const response = await fetch(url.toString());
          const body = (await response.json().catch(() => ({}))) as {
            bookings?: Booking[];
            error?: string;
          };
          if (!response.ok) throw new Error(body.error ?? "booking_load_failed");
          if (!cancelled) {
            const eligible = (body.bookings ?? []).filter(
              (booking) => booking.primary_contact?.email,
            );
            setBookings(eligible);
            setBookingId((current) =>
              eligible.some((booking) => booking.id === current) ? current : (eligible[0]?.id ?? ""),
            );
          }
        } catch {
          if (!cancelled) {
            setBookings([]);
            setBookingId("");
            setError("Could not load confirmed bookings. Please try again.");
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [query]);

  const selectedBooking = bookings.find((booking) => booking.id === bookingId) ?? null;

  async function submit() {
    if (loading || !selectedBooking || (delivery === "schedule" && !scheduleAt)) return;
    const submittedBookingId = selectedBooking.id;
    const submittedPhase = phase;
    const submittedDelivery = delivery;
    const submittedScheduleAt = scheduleAt;
    setSubmitting(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await fetch("/api/precruise-emails/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: submittedDelivery,
          booking_id: submittedBookingId,
          phase: submittedPhase,
          ...(submittedDelivery === "schedule" ? { scheduled_for: new Date(submittedScheduleAt).toISOString() } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(ERROR_MESSAGES[body.error ?? ""] ?? "The email could not be queued. Please try again.");
        return;
      }
      const timing = PHASES.find((item) => item.value === submittedPhase)?.timing ?? submittedPhase;
      setSuccess(
        submittedDelivery === "send_now"
          ? `The ${timing} email is queued to send now.`
          : `The ${timing} email is scheduled for ${new Date(submittedScheduleAt).toLocaleString()}.`,
      );
    } catch {
      setError("The email could not be queued. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <header className="mb-7">
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-700">
          Customer communications
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-gray-950">Pre-cruise emails</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-600">
          Send one of the four trip-preparation emails now or choose a future delivery time.
          Automatic reminders continue on their normal cadence; each phase sends only once per booking.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Step 1</p>
                <h2 className="mt-1 text-lg font-semibold text-gray-950">Choose a confirmed booking</h2>
              </div>
              {selectedBooking?.primary_contact?.email && (
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                  Email ready
                </span>
              )}
            </div>
            <label className="block text-sm font-medium text-gray-700">
              Search traveler
              <input
                type="search"
                value={query}
                disabled={submitting}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setBookings([]);
                  setBookingId("");
                  setLoading(true);
                  setError(null);
                  setSuccess(null);
                }}
                placeholder="Name or email"
                className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </label>
            <label className="mt-4 block text-sm font-medium text-gray-700">
              Booking
              <select
                value={bookingId}
                onChange={(event) => setBookingId(event.target.value)}
                disabled={loading || submitting || bookings.length === 0}
                className="mt-1.5 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50"
              >
                {bookings.length === 0 ? (
                  <option value="">{loading ? "Loading confirmed bookings…" : "No eligible bookings found"}</option>
                ) : (
                  bookings.map((booking) => (
                    <option key={booking.id} value={booking.id}>{bookingLabel(booking)}</option>
                  ))
                )}
              </select>
            </label>
          </section>

          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Step 2</p>
            <h2 className="mt-1 text-lg font-semibold text-gray-950">Choose the email</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {PHASES.map((item) => {
                const selected = item.value === phase;
                return (
                  <label
                    key={item.value}
                    className={`cursor-pointer rounded-xl border p-4 transition focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-200 ${
                      selected ? "border-blue-500 bg-blue-50 ring-2 ring-blue-100" : "border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="phase"
                      value={item.value}
                      checked={selected}
                      disabled={submitting}
                      onChange={() => setPhase(item.value)}
                      className="sr-only"
                    />
                    <span className="text-xs font-bold uppercase tracking-wider text-blue-700">T−{item.timing}</span>
                    <span className="mt-1 block font-semibold text-gray-950">{item.title}</span>
                    <span className="mt-1 block text-sm leading-5 text-gray-600">{item.description}</span>
                  </label>
                );
              })}
            </div>
          </section>

          <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Step 3</p>
            <h2 className="mt-1 text-lg font-semibold text-gray-950">Choose delivery</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {(["send_now", "schedule"] as const).map((option) => (
                <label
                  key={option}
                  className={`cursor-pointer rounded-xl border px-4 py-3 ${
                    delivery === option ? "border-blue-500 bg-blue-50" : "border-gray-200"
                  }`}
                >
                  <input
                    type="radio"
                    name="delivery"
                    value={option}
                    checked={delivery === option}
                    disabled={submitting}
                    onChange={() => setDelivery(option)}
                    className="mr-2"
                  />
                  <span className="font-medium text-gray-900">{option === "send_now" ? "Send now" : "Schedule"}</span>
                </label>
              ))}
            </div>
            {delivery === "schedule" && (
              <label className="mt-4 block text-sm font-medium text-gray-700">
                Delivery date and time
                <input
                  type="datetime-local"
                  min={minScheduleValue}
                  value={scheduleAt}
                  disabled={submitting}
                  onChange={(event) => setScheduleAt(event.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm shadow-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                />
                <span className="mt-1 block text-xs font-normal text-gray-500">Uses your current local time zone.</span>
              </label>
            )}
          </section>
        </div>

        <aside className="h-fit rounded-2xl bg-slate-950 p-5 text-white shadow-lg lg:sticky lg:top-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-300">Ready to deliver</p>
          <h2 className="mt-2 text-xl font-semibold">Review</h2>
          <dl className="mt-5 space-y-4 text-sm">
            <div>
              <dt className="text-slate-400">Traveler</dt>
              <dd className="mt-1 font-medium">{selectedBooking ? bookingLabel(selectedBooking) : "Choose a booking"}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Email</dt>
              <dd className="mt-1 font-medium">{PHASES.find((item) => item.value === phase)?.title}</dd>
            </div>
            <div>
              <dt className="text-slate-400">Delivery</dt>
              <dd className="mt-1 font-medium">{delivery === "send_now" ? "Send now" : scheduleAt ? new Date(scheduleAt).toLocaleString() : "Choose a time"}</dd>
            </div>
          </dl>

          {error && <p role="alert" className="mt-5 rounded-lg bg-red-950/70 p-3 text-sm text-red-100">{error}</p>}
          {success && <p role="status" className="mt-5 rounded-lg bg-emerald-950/70 p-3 text-sm text-emerald-100">{success}</p>}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={loading || !selectedBooking || submitting || (delivery === "schedule" && !scheduleAt)}
            className="mt-6 w-full rounded-lg bg-blue-500 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Queuing…" : delivery === "send_now" ? "Send email now" : "Schedule email"}
          </button>
          <p className="mt-3 text-xs leading-5 text-slate-400">
            The customer receives the same personalized, branded email used by the automatic series.
          </p>
        </aside>
      </div>
    </div>
  );
}
