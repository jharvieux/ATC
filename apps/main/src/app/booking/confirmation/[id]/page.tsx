"use client";

// §20.2 — Post-submit confirmation landing page for the platform-native
// booking flow. Stage 4 of the flow POSTs to /api/bookings/[id]/submit
// then redirects here. The page reads the booking back and shows status
// + next-steps copy depending on host_adapter outcome.

import { useEffect, useState } from "react";
import { TenantOfRecordDisclosure } from "@/components/booking/TenantOfRecordDisclosure";

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

type TenantOfRecordData = {
  tenant: { name: string; support_email: string };
  hostAgency: { legal_name: string };
};

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

const TONE_CLASSES = {
  good: {
    border: "border-2 border-emerald-600",
    bg: "bg-emerald-50 dark:bg-emerald-950/20",
    heading: "text-emerald-700 dark:text-emerald-400",
  },
  wait: {
    border: "border-2 border-amber-500",
    bg: "bg-amber-50 dark:bg-amber-950/20",
    heading: "text-amber-700 dark:text-amber-400",
  },
  bad: {
    border: "border-2 border-red-600",
    bg: "bg-red-50 dark:bg-red-950/20",
    heading: "text-red-700 dark:text-red-400",
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
  // Client-page async-params convention: resolve the params promise into state
  // (matches the sibling booking/flow page), rather than the `use()` hook.
  const [id, setId] = useState<string | null>(null);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disclosure, setDisclosure] = useState<TenantOfRecordData | null>(null);
  const [disclosureError, setDisclosureError] = useState(false);

  useEffect(() => {
    void params.then((p) => setId(p.id));
  }, [params]);

  useEffect(() => {
    if (!id) return;
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

  // §20.7 (#1876) — tenant-of-record disclosure on the confirmation surface.
  // Fail-closed on the legal names (never fabricate a placeholder), but a
  // failure to load them is surfaced as a visible notice rather than silently
  // omitted — this is a required §20.7 legal surface. Matches the sibling
  // Review-stage flow page. Post-submission, so nothing is blocked.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/bookings/${id}/tenant-of-record`);
        if (!res.ok) {
          if (!cancelled) setDisclosureError(true);
          return;
        }
        const data = (await res.json()) as {
          tenant: { name: string | null; support_email: string };
          host_agency: { legal_name: string | null };
        };
        if (!data.tenant.name || !data.host_agency.legal_name) {
          if (!cancelled) setDisclosureError(true);
          return;
        }
        if (!cancelled) {
          setDisclosure({
            tenant: { name: data.tenant.name, support_email: data.tenant.support_email },
            hostAgency: { legal_name: data.host_agency.legal_name },
          });
        }
      } catch {
        if (!cancelled) setDisclosureError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id || loading) {
    return (
      <main className="max-w-[700px] mx-auto px-6 py-12">
        <p className="text-muted-foreground">Loading your booking…</p>
      </main>
    );
  }

  if (error || !booking) {
    return (
      <main className="max-w-[700px] mx-auto px-6 py-12">
        <h1 className="text-red-600">We couldn&apos;t find that booking</h1>
        <p className="text-muted-foreground">
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
  const tc = TONE_CLASSES[copy.tone];

  return (
    <main className="max-w-[700px] mx-auto px-6 py-12">
      <div className={`${tc.bg} ${tc.border} rounded-xl p-6 mb-8`}>
        <h1 className={`m-0 text-[24px] ${tc.heading}`}>{copy.headline}</h1>
        <p className="mt-3 mb-0 text-foreground leading-[1.5]">{copy.body}</p>
      </div>

      <section className="mb-8">
        <h2 className="text-[16px] font-bold text-[#1f4e79] mb-3">
          Trip details
        </h2>
        <dl className="grid grid-cols-[180px_1fr] gap-y-2 text-[14px]">
          <dt className="text-muted-foreground">Cruise</dt>
          <dd className="m-0">
            {booking.cruise_line ?? "—"} {booking.ship_name ?? ""}
          </dd>
          <dt className="text-muted-foreground">Sailing date</dt>
          <dd className="m-0">{booking.sailing_date ?? "—"}</dd>
          <dt className="text-muted-foreground">Duration</dt>
          <dd className="m-0">
            {booking.duration_nights ? `${booking.duration_nights} nights` : "—"}
          </dd>
          <dt className="text-muted-foreground">Cabin</dt>
          <dd className="m-0">{booking.cabin_category ?? "—"}</dd>
          <dt className="text-muted-foreground">Total</dt>
          <dd className="m-0 font-semibold">
            {money(booking.total_amount, booking.currency)}
          </dd>
          {booking.host_booking_reference && (
            <>
              <dt className="text-muted-foreground">Booking reference</dt>
              <dd className="m-0 font-mono text-[13px]">
                {booking.host_booking_reference}
              </dd>
            </>
          )}
        </dl>
      </section>

      {disclosure ? (
        <section className="mb-8">
          <TenantOfRecordDisclosure tenant={disclosure.tenant} hostAgency={disclosure.hostAgency} />
        </section>
      ) : disclosureError ? (
        <section className="mb-8">
          <div className="px-4 py-3 bg-red-50 dark:bg-red-950/20 border border-red-300 dark:border-red-800 rounded-md text-red-700 dark:text-red-400 text-[13px]">
            Couldn&apos;t load the tenant-of-record disclosure. Contact your travel agent if you need it.
          </div>
        </section>
      ) : null}

      <section className="border-t border-border pt-5 text-muted-foreground text-[13px]">
        <p className="m-0">
          Booking ID: <span className="font-mono">{booking.id}</span>
        </p>
        <p className="mt-2 mb-0">
          Questions? Reply to your travel agent&apos;s most recent email — they have the
          full context.
        </p>
      </section>
    </main>
  );
}
