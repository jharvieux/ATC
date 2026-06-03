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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

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

  if (!resolvedParams) return <div className="p-8">Loading…</div>;

  const stageNum = parseInt(resolvedParams.stage, 10) as StageNum;
  const validStage = [1, 2, 3, 4].includes(stageNum);

  return (
    <NoAnonGuard bookingId={resolvedParams.id} returnStage={resolvedParams.stage}>
      <div className="max-w-[900px] mx-auto px-4 py-6 grid grid-cols-[1fr_340px] gap-6">
        <div>
          <StageProgress currentStage={validStage ? stageNum : 1} />
          {validStage ? (
            <StageContent bookingId={resolvedParams.id} stage={stageNum} />
          ) : (
            <p className="text-red-600">Invalid stage: {resolvedParams.stage}. Valid stages: 1–4.</p>
          )}
        </div>

        {/* §20.4 — AI co-pilot panel, scoped to this booking. */}
        <aside className="bg-muted border border-border rounded-xl p-4 h-fit sticky top-6">
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

  if (!checked) return <div className="p-8 text-muted-foreground">Checking authentication…</div>;

  return <>{children}</>;
}

function StageProgress({ currentStage }: { currentStage: StageNum }): React.ReactElement {
  return (
    <nav aria-label="Booking progress" className="flex mb-8">
      {STAGES.map((s, idx) => {
        const done = s.num < currentStage;
        const active = s.num === currentStage;
        return (
          <div key={s.num} className="flex items-center flex-1">
            <div className="flex flex-col items-center gap-1">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-[13px] font-bold ${
                  done ? "bg-emerald-600 text-white" : active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
              >
                {done ? "✓" : s.num}
              </div>
              <span className={`text-[11px] whitespace-nowrap ${active ? "text-primary font-semibold" : "text-muted-foreground"}`}>
                {s.label}
              </span>
            </div>
            {idx < STAGES.length - 1 && (
              <div className={`flex-1 h-0.5 mx-1 mb-5 ${done ? "bg-emerald-600" : "bg-border"}`} />
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
        <p className="text-muted-foreground">Loading your booking…</p>
      </section>
    );
  }

  return (
    <section>
      <h2 className="text-[18px] font-bold mb-5">Trip Details</h2>
      <p className="text-muted-foreground text-[13px] mb-5">Booking ID: {bookingId}</p>

      {error && (
        <div className="px-4 py-3 bg-red-50 dark:bg-red-950/20 border border-red-300 dark:border-red-800 rounded-md text-red-700 dark:text-red-400 text-[14px] mb-4">
          {error}
        </div>
      )}

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
        <FormField label="Cruise Line" name="cruise_line" required value={values.cruise_line} onChange={(v) => update("cruise_line", v)} />
        <FormField label="Ship Name" name="ship_name" required value={values.ship_name} onChange={(v) => update("ship_name", v)} />
        <FormField label="Sailing Date" name="sailing_date" type="date" required value={values.sailing_date} onChange={(v) => update("sailing_date", v)} />
        <FormField label="Departure Port" name="departure_port" required value={values.departure_port} onChange={(v) => update("departure_port", v)} />
        <FormField label="Duration (nights)" name="duration_nights" type="number" required value={values.duration_nights} onChange={(v) => update("duration_nights", v)} />
        <FormField label="Cabin Category" name="cabin_category" required value={values.cabin_category} onChange={(v) => update("cabin_category", v)} />

        <div className="flex justify-end mt-3">
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save & continue →"}
          </Button>
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

  if (loading) return <section><p className="text-muted-foreground">Loading passengers…</p></section>;

  return (
    <section>
      <h2 className="text-[18px] font-bold mb-5">Passenger Details</h2>

      {error && (
        <div className="px-4 py-3 bg-red-50 dark:bg-red-950/20 border border-red-300 dark:border-red-800 rounded-md text-red-700 dark:text-red-400 text-[14px] mb-4">
          {error}
        </div>
      )}

      {passengers.map((p, idx) => (
        <div key={idx} className="mb-6 p-5 border border-border rounded-lg">
          <h3 className="text-[14px] font-semibold mb-4">
            Passenger {idx + 1} {p.is_lead_passenger ? "(Lead)" : ""}
          </h3>
          <div className="flex flex-col gap-3">
            <FormField label="Legal First Name" name={`p${idx}_first`} required value={p.legal_first_name} onChange={(v) => updatePassenger(idx, "legal_first_name", v)} />
            <FormField label="Legal Last Name" name={`p${idx}_last`} required value={p.legal_last_name} onChange={(v) => updatePassenger(idx, "legal_last_name", v)} />

            <div className="flex flex-col gap-1">
              <Label htmlFor={`p${idx}_dob`}>
                Date of Birth <span className="text-red-600">*</span>
              </Label>
              <Input
                id={`p${idx}_dob`}
                type="date"
                required
                value={p.date_of_birth}
                onChange={(e) => updatePassenger(idx, "date_of_birth", e.target.value)}
              />
            </div>

            {/* §20.5 — Estimated DOB warning */}
            <div className="flex items-center gap-2">
              <Checkbox
                id={`p${idx}_estimated`}
                checked={p.date_of_birth_is_estimated}
                onCheckedChange={(checked) => updatePassenger(idx, "date_of_birth_is_estimated", !!checked)}
              />
              <Label htmlFor={`p${idx}_estimated`} className="text-[13px] font-normal cursor-pointer">
                Date of birth is approximate (I don&apos;t have the exact date)
              </Label>
            </div>

            {p.date_of_birth_is_estimated && (
              <div className="px-[14px] py-2.5 bg-amber-50 dark:bg-amber-950/20 border border-amber-300 dark:border-amber-700 rounded-md text-[13px] text-amber-800 dark:text-amber-400">
                ⚠ Approximate DOB flagged. You must confirm the exact date before submitting the booking.
              </div>
            )}

            <FormField label="Passport Number" name={`p${idx}_passport`} value={p.passport_number} onChange={(v) => updatePassenger(idx, "passport_number", v)} />
            <FormField label="Passport Expiry" name={`p${idx}_expiry`} type="date" value={p.passport_expiry} onChange={(v) => updatePassenger(idx, "passport_expiry", v)} />
            <FormField label="Passport Country" name={`p${idx}_country`} value={p.passport_country} onChange={(v) => updatePassenger(idx, "passport_country", v)} />

            {idx > 0 && (
              <Button
                type="button"
                variant="outline"
                className="self-start border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/20"
                onClick={() => setPassengers((prev) => prev.filter((_, i) => i !== idx))}
              >
                Remove passenger
              </Button>
            )}
          </div>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        className="mb-5 border-dashed border-primary text-primary"
        onClick={() => setPassengers((prev) => [...prev, emptyPassenger(false)])}
      >
        + Add another passenger
      </Button>

      <div className="flex gap-3 mt-2">
        <Button type="button" variant="outline" asChild>
          <a href={`/booking/flow/${bookingId}/1`}>← Back</a>
        </Button>
        <Button type="button" onClick={() => void handleAdvance()} disabled={saving}>
          {saving ? "Saving…" : "Save & continue →"}
        </Button>
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

  if (loading) return <section><p className="text-muted-foreground">Loading options…</p></section>;

  return (
    <section>
      <h2 className="text-[18px] font-bold mb-5">Booking Options</h2>

      {error && (
        <div className="px-4 py-3 bg-red-50 dark:bg-red-950/20 border border-red-300 dark:border-red-800 rounded-md text-red-700 dark:text-red-400 text-[14px] mb-4">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {AVAILABLE_OPTIONS.map((opt) => (
          <OptionCard
            key={opt.kind}
            name={opt.kind}
            label={opt.label}
            description={opt.description}
            price={opt.price_display}
            checked={selected.has(opt.kind)}
            onChange={(checked) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (checked) {
                  next.add(opt.kind);
                } else {
                  next.delete(opt.kind);
                }
                return next;
              })
            }
          />
        ))}
      </div>

      <div className="flex gap-3 mt-6">
        <Button type="button" variant="outline" asChild>
          <a href={`/booking/flow/${bookingId}/2`}>← Back</a>
        </Button>
        <Button type="button" onClick={() => void handleAdvance()} disabled={saving}>
          {saving ? "Saving…" : "Continue →"}
        </Button>
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
      <h2 className="text-[18px] font-bold mb-5">Review &amp; Submit</h2>

      <div className="p-5 bg-muted rounded-lg mb-5">
        <h3 className="text-[14px] font-semibold mb-3">Booking Summary</h3>
        <p className="text-muted-foreground text-[13px]">Booking ID: {bookingId}</p>
        <p className="text-muted-foreground text-[13px]">Review your trip details and passenger information before submitting.</p>
      </div>

      {/* §20.7 — Tenant-of-record disclosure (required on Review stage) */}
      <div className="mb-5">
        <TenantOfRecordDisclosure
          tenant={{ name: "Your Agency", support_email: "support@youragency.com" }}
          hostAgency={{ legal_name: "Host Agency" }}
        />
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-50 dark:bg-red-950/20 border border-red-300 dark:border-red-800 rounded-md text-red-700 dark:text-red-400 text-[14px] mb-4">
          {error}
        </div>
      )}

      <div className="flex gap-3 items-center">
        <Button type="button" variant="outline" asChild>
          <a href={`/booking/flow/${bookingId}/3`}>← Back</a>
        </Button>
        <Button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting}
          className="font-bold"
        >
          {submitting ? "Submitting…" : "Confirm & Submit Booking"}
        </Button>
      </div>
    </section>
  );
}

function OptionCard({ name, label, description, price, checked, onChange }: { name: string; label: string; description: string; price: string; checked: boolean; onChange: (checked: boolean) => void }): React.ReactElement {
  return (
    <label
      className={`flex items-start gap-3.5 px-5 py-4 rounded-lg cursor-pointer transition-colors ${
        checked ? "border-2 border-primary bg-primary/5" : "border border-border bg-card"
      }`}
    >
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div>
        <div className="font-semibold text-[14px] text-foreground">
          {label} — <span className="text-emerald-600">{price}</span>
        </div>
        <div className="text-[13px] text-muted-foreground mt-1">{description}</div>
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
  value: string;
  onChange: (v: string) => void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={name}>
        {label} {required && <span className="text-red-600">*</span>}
      </Label>
      <Input
        id={name}
        type={type}
        name={name}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
