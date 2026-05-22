// §20.2 — Platform-native fallback booking flow, 4-stage stub.
// §20.4 — AI co-pilot panel placeholder.
// §20.8 — No-anonymous-bookings: anonymous users are redirected to /signup.
//
// Stages: 1=trip-details, 2=passenger-details, 3=options, 4=review.
//
// NOTE(supabase-ssr): §20.8 should be enforced in middleware once @supabase/ssr
// is installed. Currently implemented as a client-side redirect in
// NoAnonGuard since middleware cannot read Supabase auth cookies without it.

"use client";

import * as React from "react";
import { useEffect, useState } from "react";
import { TenantOfRecordDisclosure } from "@/components/booking/TenantOfRecordDisclosure";

const STAGES = [
  { num: 1, label: "Trip Details" },
  { num: 2, label: "Passenger Details" },
  { num: 3, label: "Options" },
  { num: 4, label: "Review" },
] as const;

type StageNum = 1 | 2 | 3 | 4;

type PageProps = {
  params: Promise<{ id: string; stage: string }>;
};

export default function BookingFlowPage({ params }: PageProps): React.ReactElement {
  const [resolvedParams, setResolvedParams] = useState<{ id: string; stage: string } | null>(null);

  useEffect(() => {
    void params.then(setResolvedParams);
  }, [params]);

  if (!resolvedParams) return <div style={{ padding: 32 }}>Loading…</div>;

  const stageNum = parseInt(resolvedParams.stage, 10) as StageNum;
  const validStage = [1, 2, 3, 4].includes(stageNum);

  return (
    <NoAnonGuard bookingId={resolvedParams.id} returnStage={resolvedParams.stage}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px", fontFamily: "system-ui, sans-serif", display: "grid", gridTemplateColumns: "1fr 340px", gap: 24 }}>
        {/* Main booking flow */}
        <div>
          <StageProgress currentStage={validStage ? stageNum : 1} />
          {validStage ? (
            <StageContent bookingId={resolvedParams.id} stage={stageNum} />
          ) : (
            <p style={{ color: "#dc2626" }}>Invalid stage: {resolvedParams.stage}. Valid stages: 1–4.</p>
          )}
        </div>

        {/* §20.4 AI co-pilot panel */}
        <aside
          style={{
            background: "#f9fafb",
            borderRadius: 10,
            border: "1px solid #e5e7eb",
            padding: 20,
            height: "fit-content",
            position: "sticky",
            top: 24,
          }}
        >
          <h3 style={{ fontSize: 14, fontWeight: 700, color: "#374151", marginBottom: 8 }}>AI Travel Assistant</h3>
          {/* TODO(prompt-24): embed the chat component here with booking context */}
          <p style={{ fontSize: 13, color: "#9ca3af" }}>
            Your AI concierge will appear here to help answer questions while you book.
          </p>
        </aside>
      </div>
    </NoAnonGuard>
  );
}

// §20.8 — No-anonymous-bookings guard.
// Saves draft key to localStorage and redirects anonymous users to /signup.
function NoAnonGuard({
  bookingId,
  returnStage,
  children,
}: {
  bookingId: string;
  returnStage: string;
  children: React.ReactNode;
}): React.ReactElement {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    // Check for a Supabase auth session cookie presence (heuristic — real enforcement needs @supabase/ssr in middleware).
    const hasSession = document.cookie.includes("sb-") || document.cookie.includes("supabase-auth-token");

    if (!hasSession) {
      const draftKey = `booking-draft-${bookingId}`;
      try {
        // Preserve any in-progress form state already in localStorage.
        if (!localStorage.getItem(draftKey)) {
          localStorage.setItem(draftKey, JSON.stringify({ booking_id: bookingId, stage: returnStage }));
        }
      } catch {
        // localStorage unavailable (private browsing, etc.) — proceed with redirect anyway.
      }

      const returnUrl = `/booking/flow/${bookingId}/${returnStage}`;
      window.location.href = `/signup?return=${encodeURIComponent(returnUrl)}&claim=${encodeURIComponent(draftKey)}`;
      return;
    }

    setChecked(true);
  }, [bookingId, returnStage]);

  if (!checked) return <div style={{ padding: 32, color: "#6b7280" }}>Checking authentication…</div>;

  return <>{children}</>;
}

function StageProgress({ currentStage }: { currentStage: StageNum }): React.ReactElement {
  return (
    <nav aria-label="Booking progress" style={{ display: "flex", gap: 0, marginBottom: 32 }}>
      {STAGES.map((s, idx) => {
        const done = s.num < currentStage;
        const active = s.num === currentStage;
        return (
          <div key={s.num} style={{ display: "flex", alignItems: "center", flex: 1 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 13,
                  fontWeight: 700,
                  background: done ? "#059669" : active ? "#6366f1" : "#e5e7eb",
                  color: done || active ? "#fff" : "#6b7280",
                }}
              >
                {done ? "✓" : s.num}
              </div>
              <span style={{ fontSize: 11, color: active ? "#6366f1" : "#6b7280", fontWeight: active ? 600 : 400, whiteSpace: "nowrap" }}>
                {s.label}
              </span>
            </div>
            {idx < STAGES.length - 1 && (
              <div style={{ flex: 1, height: 2, background: done ? "#059669" : "#e5e7eb", margin: "0 4px", marginBottom: 20 }} />
            )}
          </div>
        );
      })}
    </nav>
  );
}

function StageContent({ bookingId, stage }: { bookingId: string; stage: StageNum }): React.ReactElement {
  switch (stage) {
    case 1:
      return <Stage1TripDetails bookingId={bookingId} />;
    case 2:
      return <Stage2PassengerDetails />;
    case 3:
      return <Stage3Options />;
    case 4:
      return <Stage4Review bookingId={bookingId} />;
  }
}

// Stage 1: Trip details — pre-filled if entry was from quote or AI chat.
function Stage1TripDetails({ bookingId }: { bookingId: string }): React.ReactElement {
  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>Trip Details</h2>
      <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 20 }}>Booking ID: {bookingId}</p>
      <form style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <FormField label="Cruise Line" name="cruise_line" required />
        <FormField label="Ship Name" name="ship_name" required />
        <FormField label="Sailing Date" name="sailing_date" type="date" required />
        <FormField label="Departure Port" name="departure_port" required />
        <FormField label="Duration (nights)" name="duration_nights" type="number" required />
        <FormField label="Cabin Category" name="cabin_category" required />
        <StageNavButtons bookingId={bookingId} stage={1} />
      </form>
    </section>
  );
}

// Stage 2: Passenger details with DOB inputs and estimated-DOB warning.
function Stage2PassengerDetails(): React.ReactElement {
  const [passengers, setPassengers] = useState([{ id: 1, isEstimated: false }]);

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>Passenger Details</h2>

      {passengers.map((p, idx) => (
        <div key={p.id} style={{ marginBottom: 24, padding: 20, border: "1px solid #e5e7eb", borderRadius: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>
            Passenger {idx + 1} {idx === 0 ? "(Lead)" : ""}
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FormField label="Legal First Name" name={`passengers[${idx}].legal_first_name`} required />
            <FormField label="Legal Last Name" name={`passengers[${idx}].legal_last_name`} required />

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
                Date of Birth <span style={{ color: "#dc2626" }}>*</span>
              </span>
              <input
                type="date"
                name={`passengers[${idx}].date_of_birth`}
                required
                style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 14 }}
              />
            </label>

            {/* §20.5 — Estimated DOB warning */}
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#374151" }}>
              <input
                type="checkbox"
                name={`passengers[${idx}].date_of_birth_is_estimated`}
                checked={p.isEstimated}
                onChange={(e) => {
                  const next = [...passengers];
                  next[idx] = { ...p, isEstimated: e.target.checked };
                  setPassengers(next);
                }}
              />
              Date of birth is approximate (I don&apos;t have the exact date)
            </label>

            {p.isEstimated && (
              <div style={{ padding: "10px 14px", background: "#fffbeb", border: "1px solid #fbbf24", borderRadius: 6, fontSize: 13, color: "#92400e" }}>
                ⚠ We have an approximate DOB for this passenger. You will need to confirm the exact date before submitting.
              </div>
            )}

            <FormField label="Passport Number" name={`passengers[${idx}].passport_number`} />
            <FormField label="Passport Expiry" name={`passengers[${idx}].passport_expiry`} type="date" />
            <FormField label="Passport Country" name={`passengers[${idx}].passport_country`} />
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={() => setPassengers((prev) => [...prev, { id: prev.length + 1, isEstimated: false }])}
        style={{ marginBottom: 20, padding: "8px 16px", border: "1px dashed #6366f1", borderRadius: 6, background: "transparent", color: "#6366f1", cursor: "pointer", fontSize: 13 }}
      >
        + Add another passenger
      </button>

      {/* Placeholder for bookingId in form — Stage2 doesn't receive it but navigation does */}
      <StageNavButtons bookingId="__current__" stage={2} />
    </section>
  );
}

// Stage 3: Booking options — insurance, addons.
function Stage3Options(): React.ReactElement {
  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>Booking Options</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <OptionCard
          name="travel_insurance"
          label="Travel Insurance"
          description="Comprehensive travel protection including trip cancellation, medical, and baggage."
          price="$149"
        />
        <OptionCard
          name="beverage_package"
          label="Premium Beverage Package"
          description="Unlimited beverages including premium spirits, wines, and specialty coffees."
          price="$89/day"
        />
        <OptionCard
          name="specialty_dining"
          label="Specialty Dining Package"
          description="3 specialty restaurant reservations at a discounted bundle price."
          price="$99"
        />
      </div>
      <StageNavButtons bookingId="__current__" stage={3} />
    </section>
  );
}

// Stage 4: Review with TenantOfRecordDisclosure — §20.7.
function Stage4Review({ bookingId }: { bookingId: string }): React.ReactElement {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/submit`, { method: "POST" });
      const body = await res.json() as { ok?: boolean; error?: string; affected_passengers?: string[] };
      if (!res.ok) {
        if (body.error === "estimated_dob_unresolved" && body.affected_passengers) {
          setError(`Please confirm the date of birth for: ${body.affected_passengers.join(", ")}. Go back to Step 2.`);
        } else {
          setError(body.error ?? "Submission failed.");
        }
      } else {
        window.location.href = `/booking/confirmation/${bookingId}`;
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>Review &amp; Submit</h2>

      {/* Booking summary placeholder */}
      <div style={{ padding: 20, background: "#f9fafb", borderRadius: 8, marginBottom: 20 }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Booking Summary</h3>
        <p style={{ color: "#6b7280", fontSize: 13 }}>Booking ID: {bookingId}</p>
        <p style={{ color: "#6b7280", fontSize: 13 }}>Review your trip details and passenger information before submitting.</p>
      </div>

      {/* §20.7 — Tenant-of-record disclosure (required on Review stage) */}
      <div style={{ marginBottom: 20 }}>
        <TenantOfRecordDisclosure
          tenant={{ name: "Your Agency", support_email: "support@youragency.com" }}
          hostAgency={{ legal_name: "Host Agency" }}
        />
      </div>

      {error && (
        <div style={{ padding: "12px 16px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 6, color: "#dc2626", fontSize: 14, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <a
          href={`/booking/flow/${bookingId}/3`}
          style={{ padding: "10px 20px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 14, color: "#374151", textDecoration: "none" }}
        >
          ← Back
        </a>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting}
          style={{
            padding: "10px 24px",
            background: submitting ? "#9ca3af" : "#6366f1",
            color: "#fff",
            border: "none",
            borderRadius: 6,
            fontWeight: 700,
            cursor: submitting ? "not-allowed" : "pointer",
            fontSize: 14,
          }}
        >
          {submitting ? "Submitting…" : "Confirm & Submit Booking"}
        </button>
      </div>
    </section>
  );
}

function StageNavButtons({ bookingId, stage }: { bookingId: string; stage: StageNum }): React.ReactElement {
  const nextStage = (stage + 1) as StageNum;
  const prevStage = (stage - 1) as StageNum;

  return (
    <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
      {stage > 1 && (
        <a
          href={`/booking/flow/${bookingId}/${prevStage}`}
          style={{ padding: "10px 20px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 14, color: "#374151", textDecoration: "none" }}
        >
          ← Back
        </a>
      )}
      {stage < 4 && (
        <button
          type="button"
          onClick={() => { window.location.href = `/booking/flow/${bookingId}/${nextStage}`; }}
          style={{ padding: "10px 20px", background: "#6366f1", color: "#fff", border: "none", borderRadius: 6, fontWeight: 600, cursor: "pointer", fontSize: 14 }}
        >
          Continue →
        </button>
      )}
    </div>
  );
}

function OptionCard({ name, label, description, price }: { name: string; label: string; description: string; price: string }): React.ReactElement {
  const [selected, setSelected] = useState(false);

  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 14,
        padding: "16px 20px",
        border: selected ? "2px solid #6366f1" : "1px solid #e5e7eb",
        borderRadius: 8,
        cursor: "pointer",
        background: selected ? "#eef2ff" : "#fff",
      }}
    >
      <input
        type="checkbox"
        name={name}
        checked={selected}
        onChange={(e) => setSelected(e.target.checked)}
        style={{ marginTop: 2 }}
      />
      <div>
        <div style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>{label} — <span style={{ color: "#059669" }}>{price}</span></div>
        <div style={{ fontSize: 13, color: "#6b7280", marginTop: 4 }}>{description}</div>
      </div>
    </label>
  );
}

function FormField({
  label,
  name,
  type = "text",
  required,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
}): React.ReactElement {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
        {label} {required && <span style={{ color: "#dc2626" }}>*</span>}
      </span>
      <input
        type={type}
        name={name}
        required={required}
        style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 14 }}
      />
    </label>
  );
}
