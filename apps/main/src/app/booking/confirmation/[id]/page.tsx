"use client";

// §20.2 — Post-submit confirmation landing page for the platform-native
// booking flow. Stage 4 of the flow POSTs to /api/bookings/[id]/submit
// then redirects here. The page reads the booking back and shows status
// + next-steps copy depending on host_adapter outcome.

import { use, useEffect, useState } from "react";

interface Booking {
  id: string;
  status: string;
  cruise_line: string | null;
  ship_name: string | null;
  sailing_date: string | null;
  duration_nights: number | null;
  cabin_category: string | null;
  total_amount: string | null;
  currency: string | null;
  host_adapter: string | null;
  host_booking_reference: string | null;
}

const STATUS_COPY: Record<string, { headline: string; body: string; tone: "good" | "wait" | "bad" }> = {
  submitted: {
    headline: "Your booking is confirmed!",
    body: "We've sent the details to your host agency. You'll get a confirmation email shortly with your booking reference.",
    tone: "good",
  },
  confirmed: {
    headline: "Your booking is confirmed!",
    body: "We've sent the details to your host agency. You'll get a confirmation email shortly with your booking reference.",
    tone: "good",
  },
  submitting: {
    headline: "We're finalizing your booking…",
    body: "Your booking is being submitted to the host. This usually takes a few seconds. Refresh in a moment to see the final status.",
    tone: "wait",
  },
  pending_host_review: {
    headline: "We've passed your booking to an agent",
    body: "We weren't able to confirm the booking automatically. A human agent will review and confirm — they'll be in touch within one business day.",
    tone: "wait",
  },
  draft: {
    headline: "Your booking was saved but not submitted",
    body: "Looks like the booking didn't submit — head back and click 'Submit booking' again.",
    tone: "bad",
  },
  failed: {
    headline: "Something went wrong",
    body: "Your booking didn't submit successfully. A human agent will reach out to fix it — no action needed from you right now.",
    tone: "bad",
  },
  cancelled: {
    headline: "This booking is cancelled",
    body: "If this wasn't you, contact your travel agent right away.",
    tone: "bad",
  },
};

function money(amount: string | null, currency: string | null): string {
  if (amount === null) return "—";
  return `${currency ?? "USD"} ${amount}`;
}

export default function BookingConfirmationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/bookings/${id}`);
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          setError(err.error ?? `status_${res.status}`);
          return;
        }
        const data = (await res.json()) as { booking: Booking };
        if (!cancelled) setBooking(data.booking);
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
    return (
      <main style={{ maxWidth: 700, margin: "0 auto", padding: "48px 24px", fontFamily: "system-ui, sans-serif" }}>
        <p style={{ color: "#6b7280" }}>Loading your booking…</p>
      </main>
    );
  }

  if (error || !booking) {
    return (
      <main style={{ maxWidth: 700, margin: "0 auto", padding: "48px 24px", fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ color: "#dc2626" }}>We couldn&apos;t find that booking</h1>
        <p style={{ color: "#6b7280" }}>
          {error === "not_found"
            ? "Double-check the URL or contact your travel agent."
            : `Error: ${error ?? "unknown"}`}
        </p>
      </main>
    );
  }

  const copy = STATUS_COPY[booking.status] ?? {
    headline: "Your booking",
    body: `Status: ${booking.status.replace(/_/g, " ")}`,
    tone: "wait" as const,
  };
  const accent =
    copy.tone === "good" ? "#059669" : copy.tone === "wait" ? "#d97706" : "#dc2626";
  const bg =
    copy.tone === "good" ? "#ecfdf5" : copy.tone === "wait" ? "#fffbeb" : "#fef2f2";

  return (
    <main style={{ maxWidth: 700, margin: "0 auto", padding: "48px 24px", fontFamily: "system-ui, sans-serif" }}>
      <div
        style={{
          background: bg,
          border: `2px solid ${accent}`,
          borderRadius: 10,
          padding: 24,
          marginBottom: 32,
        }}
      >
        <h1 style={{ margin: 0, fontSize: 24, color: accent }}>{copy.headline}</h1>
        <p style={{ margin: "12px 0 0", color: "#374151", lineHeight: 1.5 }}>{copy.body}</p>
      </div>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "#1f4e79", marginBottom: 12 }}>
          Trip details
        </h2>
        <dl
          style={{
            display: "grid",
            gridTemplateColumns: "180px 1fr",
            rowGap: 8,
            fontSize: 14,
          }}
        >
          <dt style={{ color: "#6b7280" }}>Cruise</dt>
          <dd style={{ margin: 0 }}>
            {booking.cruise_line ?? "—"} {booking.ship_name ?? ""}
          </dd>
          <dt style={{ color: "#6b7280" }}>Sailing date</dt>
          <dd style={{ margin: 0 }}>{booking.sailing_date ?? "—"}</dd>
          <dt style={{ color: "#6b7280" }}>Duration</dt>
          <dd style={{ margin: 0 }}>
            {booking.duration_nights ? `${booking.duration_nights} nights` : "—"}
          </dd>
          <dt style={{ color: "#6b7280" }}>Cabin</dt>
          <dd style={{ margin: 0 }}>{booking.cabin_category ?? "—"}</dd>
          <dt style={{ color: "#6b7280" }}>Total</dt>
          <dd style={{ margin: 0, fontWeight: 600 }}>
            {money(booking.total_amount, booking.currency)}
          </dd>
          {booking.host_booking_reference && (
            <>
              <dt style={{ color: "#6b7280" }}>Booking reference</dt>
              <dd style={{ margin: 0, fontFamily: "monospace", fontSize: 13 }}>
                {booking.host_booking_reference}
              </dd>
            </>
          )}
        </dl>
      </section>

      <section
        style={{
          borderTop: "1px solid #e5e7eb",
          paddingTop: 20,
          color: "#6b7280",
          fontSize: 13,
        }}
      >
        <p style={{ margin: 0 }}>
          Booking ID: <span style={{ fontFamily: "monospace" }}>{booking.id}</span>
        </p>
        <p style={{ margin: "8px 0 0" }}>
          Questions? Reply to your travel agent&apos;s most recent email — they have the
          full context.
        </p>
      </section>
    </main>
  );
}
