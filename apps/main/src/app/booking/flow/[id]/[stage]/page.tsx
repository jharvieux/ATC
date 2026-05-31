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
import { CustomerContextChatPanel } from "@/components/chat/CustomerContextChatPanel";

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

        {/* §20.4 — AI co-pilot panel, scoped to this booking. */}
        <aside
          style={{
            background: "#f9fafb",
            borderRadius: 10,
            border: "1px solid #e5e7eb",
            padding: 16,
            height: "fit-content",
            position: "sticky",
            top: 24,
          }}
        >
          <CustomerContextChatPanel
            contextRef={{ type: "booking", id: resolvedParams.id }}
            title="AI Travel Assistant"
            placeholder="Ask about cabins, ports, options…"
          />
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
      return <Stage2PassengerDetails bookingId={bookingId} />;
    case 3:
      return <Stage3Options bookingId={bookingId} />;
    case 4:
      return <Stage4Review bookingId={bookingId} />;
  }
}

// Stage 1: Trip details — pre-filled from the booking row on mount,
// PATCHed back to /api/bookings/[id] on save. Save-then-advance UX.
function Stage1TripDetails({ bookingId }: { bookingId: string }): React.ReactElement {
  const [values, setValues] = useState({
    cruise_line: "",
    ship_name: "",
    sailing_date: "",
    departure_port: "",
    duration_nights: "",
    cabin_category: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/bookings/${bookingId}`);
        if (!res.ok) {
          setLoading(false);
          return;
        }
        const data = (await res.json()) as {
          booking: {
            cruise_line: string | null;
            ship_name: string | null;
            sailing_date: string | null;
            departure_port: string | null;
            duration_nights: number | null;
            cabin_category: string | null;
          };
        };
        if (cancelled) return;
        const b = data.booking;
        setValues({
          cruise_line: b.cruise_line ?? "",
          ship_name: b.ship_name ?? "",
          sailing_date: b.sailing_date ?? "",
          departure_port: b.departure_port ?? "",
          duration_nights: b.duration_nights !== null ? String(b.duration_nights) : "",
          cabin_category: b.cabin_category ?? "",
        });
      } catch {
        // Soft-fail prefetch — user can fill the form from scratch.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookingId]);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const patchBody: Record<string, unknown> = {
        cruise_line: values.cruise_line || null,
        ship_name: values.ship_name || null,
        sailing_date: values.sailing_date || null,
        departure_port: values.departure_port || null,
        cabin_category: values.cabin_category || null,
      };
      if (values.duration_nights) {
        const n = parseInt(values.duration_nights, 10);
        if (!Number.isNaN(n) && n > 0) patchBody.duration_nights = n;
      }
      const res = await fetch(`/api/bookings/${bookingId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok) {
        setError(body.message ?? body.error ?? `Save failed (${res.status}).`);
        return;
      }
      // Advance to Stage 2.
      window.location.href = `/booking/flow/${bookingId}/2`;
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function update(k: keyof typeof values, v: string) {
    setValues((s) => ({ ...s, [k]: v }));
  }

  if (loading) {
    return (
      <section>
        <p style={{ color: "#6b7280" }}>Loading your booking…</p>
      </section>
    );
  }

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>Trip Details</h2>
      <p style={{ color: "#6b7280", fontSize: 13, marginBottom: 20 }}>Booking ID: {bookingId}</p>

      {error && (
        <div style={{ padding: "12px 16px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 6, color: "#dc2626", fontSize: 14, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <FormField label="Cruise Line" name="cruise_line" required value={values.cruise_line} onChange={(v) => update("cruise_line", v)} />
        <FormField label="Ship Name" name="ship_name" required value={values.ship_name} onChange={(v) => update("ship_name", v)} />
        <FormField label="Sailing Date" name="sailing_date" type="date" required value={values.sailing_date} onChange={(v) => update("sailing_date", v)} />
        <FormField label="Departure Port" name="departure_port" required value={values.departure_port} onChange={(v) => update("departure_port", v)} />
        <FormField label="Duration (nights)" name="duration_nights" type="number" required value={values.duration_nights} onChange={(v) => update("duration_nights", v)} />
        <FormField label="Cabin Category" name="cabin_category" required value={values.cabin_category} onChange={(v) => update("cabin_category", v)} />

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button
            type="submit"
            disabled={saving}
            style={{
              padding: "10px 24px",
              background: saving ? "#9ca3af" : "#6366f1",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              fontSize: 14,
              fontWeight: 600,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Saving…" : "Save & continue →"}
          </button>
        </div>
      </form>
    </section>
  );
}

type PassengerForm = {
  legal_first_name: string;
  legal_last_name: string;
  date_of_birth: string;
  date_of_birth_is_estimated: boolean;
  passport_number: string;
  passport_expiry: string;
  passport_country: string;
  is_lead_passenger: boolean;
};

function emptyPassenger(isLead = false): PassengerForm {
  return {
    legal_first_name: "",
    legal_last_name: "",
    date_of_birth: "",
    date_of_birth_is_estimated: false,
    passport_number: "",
    passport_expiry: "",
    passport_country: "",
    is_lead_passenger: isLead,
  };
}

// Stage 2: Passenger details — loaded from and saved to /api/bookings/[id]/passengers.
// §20.5: Cannot advance if any passenger has date_of_birth_is_estimated = true.
function Stage2PassengerDetails({ bookingId }: { bookingId: string }): React.ReactElement {
  const [passengers, setPassengers] = useState<PassengerForm[]>([emptyPassenger(true)]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/bookings/${bookingId}/passengers`);
        if (res.ok) {
          const data = (await res.json()) as { passengers: Array<{
            legal_first_name: string;
            legal_last_name: string;
            date_of_birth: string;
            date_of_birth_is_estimated: boolean;
            passport_expiry: string | null;
            passport_country: string | null;
            is_lead_passenger: boolean;
          }> };
          if (!cancelled && data.passengers.length > 0) {
            setPassengers(data.passengers.map((p) => ({
              legal_first_name: p.legal_first_name,
              legal_last_name: p.legal_last_name,
              date_of_birth: p.date_of_birth,
              date_of_birth_is_estimated: p.date_of_birth_is_estimated,
              passport_number: "",
              passport_expiry: p.passport_expiry ?? "",
              passport_country: p.passport_country ?? "",
              is_lead_passenger: p.is_lead_passenger,
            })));
          }
        }
      } catch {
        // Soft-fail prefetch — user can fill the form from scratch.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [bookingId]);

  function updatePassenger(idx: number, field: keyof PassengerForm, value: string | boolean): void {
    setPassengers((prev) => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  }

  async function handleAdvance(): Promise<void> {
    // §20.5 — Block advance if any DOB is estimated.
    const estimatedNames = passengers
      .filter((p) => p.date_of_birth_is_estimated)
      .map((p) => `${p.legal_first_name} ${p.legal_last_name}`.trim() || "passenger");
    if (estimatedNames.length > 0) {
      setError(`Please confirm the exact date of birth for: ${estimatedNames.join(", ")}.`);
      return;
    }
    // Validate required fields.
    for (const [i, p] of passengers.entries()) {
      if (!p.legal_first_name || !p.legal_last_name || !p.date_of_birth) {
        setError(`Passenger ${i + 1}: first name, last name, and date of birth are required.`);
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/passengers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passengers }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(body.error ?? `Save failed (${res.status}).`);
        return;
      }
      window.location.href = `/booking/flow/${bookingId}/3`;
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section><p style={{ color: "#6b7280" }}>Loading passengers…</p></section>;

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>Passenger Details</h2>

      {error && (
        <div style={{ padding: "12px 16px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 6, color: "#dc2626", fontSize: 14, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {passengers.map((p, idx) => (
        <div key={idx} style={{ marginBottom: 24, padding: 20, border: "1px solid #e5e7eb", borderRadius: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>
            Passenger {idx + 1} {p.is_lead_passenger ? "(Lead)" : ""}
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <FormField label="Legal First Name" name={`p${idx}_first`} required value={p.legal_first_name} onChange={(v) => updatePassenger(idx, "legal_first_name", v)} />
            <FormField label="Legal Last Name" name={`p${idx}_last`} required value={p.legal_last_name} onChange={(v) => updatePassenger(idx, "legal_last_name", v)} />

            <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
                Date of Birth <span style={{ color: "#dc2626" }}>*</span>
              </span>
              <input
                type="date"
                required
                value={p.date_of_birth}
                onChange={(e) => updatePassenger(idx, "date_of_birth", e.target.value)}
                style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 14 }}
              />
            </label>

            {/* §20.5 — Estimated DOB warning */}
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#374151" }}>
              <input
                type="checkbox"
                checked={p.date_of_birth_is_estimated}
                onChange={(e) => updatePassenger(idx, "date_of_birth_is_estimated", e.target.checked)}
              />
              Date of birth is approximate (I don&apos;t have the exact date)
            </label>

            {p.date_of_birth_is_estimated && (
              <div style={{ padding: "10px 14px", background: "#fffbeb", border: "1px solid #fbbf24", borderRadius: 6, fontSize: 13, color: "#92400e" }}>
                ⚠ Approximate DOB flagged. You must confirm the exact date before submitting the booking.
              </div>
            )}

            <FormField label="Passport Number" name={`p${idx}_passport`} value={p.passport_number} onChange={(v) => updatePassenger(idx, "passport_number", v)} />
            <FormField label="Passport Expiry" name={`p${idx}_expiry`} type="date" value={p.passport_expiry} onChange={(v) => updatePassenger(idx, "passport_expiry", v)} />
            <FormField label="Passport Country" name={`p${idx}_country`} value={p.passport_country} onChange={(v) => updatePassenger(idx, "passport_country", v)} />

            {idx > 0 && (
              <button
                type="button"
                onClick={() => setPassengers((prev) => prev.filter((_, i) => i !== idx))}
                style={{ alignSelf: "flex-start", padding: "4px 12px", border: "1px solid #fca5a5", borderRadius: 6, background: "transparent", color: "#dc2626", cursor: "pointer", fontSize: 13 }}
              >
                Remove passenger
              </button>
            )}
          </div>
        </div>
      ))}

      <button
        type="button"
        onClick={() => setPassengers((prev) => [...prev, emptyPassenger(false)])}
        style={{ marginBottom: 20, padding: "8px 16px", border: "1px dashed #6366f1", borderRadius: 6, background: "transparent", color: "#6366f1", cursor: "pointer", fontSize: 13 }}
      >
        + Add another passenger
      </button>

      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        <a href={`/booking/flow/${bookingId}/1`} style={{ padding: "10px 20px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 14, color: "#374151", textDecoration: "none" }}>
          ← Back
        </a>
        <button
          type="button"
          onClick={() => void handleAdvance()}
          disabled={saving}
          style={{ padding: "10px 24px", background: saving ? "#9ca3af" : "#6366f1", color: "#fff", border: "none", borderRadius: 6, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", fontSize: 14 }}
        >
          {saving ? "Saving…" : "Save & continue →"}
        </button>
      </div>
    </section>
  );
}

// Catalog of available add-ons for the §20.2 fallback booking flow.
// In a live integration these would be fetched from the host adapter;
// the platform-native fallback uses a fixed set.
const AVAILABLE_OPTIONS = [
  { kind: "travel_insurance", label: "Travel Insurance", description: "Comprehensive travel protection including trip cancellation, medical, and baggage.", price_cents: 14900, price_display: "$149" },
  { kind: "beverage_package", label: "Premium Beverage Package", description: "Unlimited beverages including premium spirits, wines, and specialty coffees.", price_cents: 8900, price_display: "$89/day" },
  { kind: "specialty_dining", label: "Specialty Dining Package", description: "3 specialty restaurant reservations at a discounted bundle price.", price_cents: 9900, price_display: "$99" },
] as const;

// Stage 3: Booking options — loaded from and saved to /api/bookings/[id]/options.
function Stage3Options({ bookingId }: { bookingId: string }): React.ReactElement {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/bookings/${bookingId}/options`);
        if (res.ok) {
          const data = (await res.json()) as { options: Array<{ option_kind: string }> };
          if (!cancelled) {
            setSelected(new Set(data.options.map((o) => o.option_kind)));
          }
        }
      } catch {
        // Soft-fail — user can re-select from scratch.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [bookingId]);

  async function handleAdvance(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const options = AVAILABLE_OPTIONS
        .filter((o) => selected.has(o.kind))
        .map((o) => ({ option_kind: o.kind, option_value: { label: o.label }, price_cents: o.price_cents }));
      const res = await fetch(`/api/bookings/${bookingId}/options`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ options }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        setError(body.error ?? `Save failed (${res.status}).`);
        return;
      }
      window.location.href = `/booking/flow/${bookingId}/4`;
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section><p style={{ color: "#6b7280" }}>Loading options…</p></section>;

  return (
    <section>
      <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 20 }}>Booking Options</h2>

      {error && (
        <div style={{ padding: "12px 16px", background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 6, color: "#dc2626", fontSize: 14, marginBottom: 16 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {AVAILABLE_OPTIONS.map((opt) => (
          <OptionCard
            key={opt.kind}
            name={opt.kind}
            label={opt.label}
            description={opt.description}
            price={opt.price_display}
            checked={selected.has(opt.kind)}
            onChange={(checked) => setSelected((prev) => { const next = new Set(prev); if (checked) next.add(opt.kind); else next.delete(opt.kind); return next; })}
          />
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
        <a href={`/booking/flow/${bookingId}/2`} style={{ padding: "10px 20px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 14, color: "#374151", textDecoration: "none" }}>
          ← Back
        </a>
        <button
          type="button"
          onClick={() => void handleAdvance()}
          disabled={saving}
          style={{ padding: "10px 24px", background: saving ? "#9ca3af" : "#6366f1", color: "#fff", border: "none", borderRadius: 6, fontWeight: 600, cursor: saving ? "not-allowed" : "pointer", fontSize: 14 }}
        >
          {saving ? "Saving…" : "Continue →"}
        </button>
      </div>
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

function OptionCard({ name, label, description, price, checked, onChange }: { name: string; label: string; description: string; price: string; checked: boolean; onChange: (checked: boolean) => void }): React.ReactElement {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 14,
        padding: "16px 20px",
        border: checked ? "2px solid #6366f1" : "1px solid #e5e7eb",
        borderRadius: 8,
        cursor: "pointer",
        background: checked ? "#eef2ff" : "#fff",
      }}
    >
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
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
  value,
  onChange,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  value?: string;
  onChange?: (v: string) => void;
}): React.ReactElement {
  const isControlled = value !== undefined && onChange !== undefined;
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: "#374151" }}>
        {label} {required && <span style={{ color: "#dc2626" }}>*</span>}
      </span>
      {isControlled ? (
        <input
          type={type}
          name={name}
          required={required}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 14 }}
        />
      ) : (
        <input
          type={type}
          name={name}
          required={required}
          style={{ border: "1px solid #d1d5db", borderRadius: 6, padding: "8px 12px", fontSize: 14 }}
        />
      )}
    </label>
  );
}
