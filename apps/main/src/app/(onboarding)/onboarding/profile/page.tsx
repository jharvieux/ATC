"use client";

// §15.3 — Edit Profile (settings page, also entry point if onboarding stage is "profile").
// Pre-fills from the existing tenant record so the operator never re-types what they
// entered at signup.

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { TIMEZONES } from "@/lib/timezones";

interface ProfileData {
  legal_name: string;
  display_name: string;
  slug: string;
  support_email: string;
  support_phone: string | null;
  timezone: string;
  mailing_address: {
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  } | null;
}

export default function OnboardingProfilePage() {
  const router = useRouter();
  const [form, setForm] = useState({
    legal_name: "",
    display_name: "",
    slug: "",
    support_email: "",
    support_phone: "",
    timezone: "America/New_York",
    line1: "",
    line2: "",
    city: "",
    state: "",
    zip: "",
    country: "US",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/onboarding/profile")
      .then((r) => r.json())
      .then((data: ProfileData) => {
        const addr = data.mailing_address;
        setForm({
          legal_name:    data.legal_name    ?? "",
          display_name:  data.display_name  ?? "",
          slug:          data.slug          ?? "",
          support_email: data.support_email ?? "",
          support_phone: data.support_phone ?? "",
          timezone:      data.timezone      ?? "America/New_York",
          line1:   addr?.line1   ?? "",
          line2:   addr?.line2   ?? "",
          city:    addr?.city    ?? "",
          state:   addr?.state   ?? "",
          zip:     addr?.zip     ?? "",
          country: addr?.country ?? "US",
        });
      })
      .catch(() => setError("Failed to load profile. Please refresh."))
      .finally(() => setLoading(false));
  }, []);

  const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setSaved(false);

    const res = await fetch("/api/onboarding/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legal_name:    form.legal_name,
        display_name:  form.display_name,
        slug:          form.slug,
        mailing_address: {
          line1:   form.line1,
          line2:   form.line2 || undefined,
          city:    form.city,
          state:   form.state,
          zip:     form.zip,
          country: form.country,
        },
        support_email: form.support_email,
        support_phone: form.support_phone || undefined,
        timezone:      form.timezone,
      }),
    });

    const data = await res.json() as { ok?: boolean; next_stage?: string; error?: string };
    if (!res.ok) {
      setError(data.error ?? "Submission failed");
      setSubmitting(false);
      return;
    }

    if (data.next_stage === "legal") {
      router.push("/onboarding/legal");
    } else {
      setSaved(true);
      setSubmitting(false);
    }
  }

  if (loading) return <div className="max-w-xl mx-auto py-10 px-4 text-sm text-gray-500">Loading…</div>;

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-semibold mb-2">Business Profile</h1>
      <p className="text-sm text-gray-500 mb-6">Update your agency details. Your workspace URL cannot be changed.</p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Legal Business Name *</label>
          <input className="w-full border rounded px-3 py-2" value={form.legal_name} onChange={set("legal_name")} required />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Display Name *</label>
          <input className="w-full border rounded px-3 py-2" value={form.display_name} onChange={set("display_name")} required />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Workspace URL</label>
          <input
            className="w-full border rounded px-3 py-2 bg-gray-50 text-gray-500 cursor-default"
            value={form.slug}
            readOnly
          />
          <p className="text-xs text-gray-400 mt-1">The workspace URL is permanent and cannot be changed.</p>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Support Email *</label>
          <input type="email" className="w-full border rounded px-3 py-2" value={form.support_email} onChange={set("support_email")} required />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Support Phone</label>
          <input className="w-full border rounded px-3 py-2" value={form.support_phone} onChange={set("support_phone")} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Time Zone *</label>
          <select className="w-full border rounded px-3 py-2" value={form.timezone} onChange={set("timezone")} required>
            {TIMEZONES.map((tz) => (
              <option key={tz.value} value={tz.value}>{tz.label} ({tz.offset})</option>
            ))}
          </select>
        </div>
        <fieldset className="border rounded p-4">
          <legend className="text-sm font-medium px-1">Mailing Address *</legend>
          <div className="space-y-2 mt-2">
            <input placeholder="Street address" className="w-full border rounded px-3 py-2" value={form.line1} onChange={set("line1")} required />
            <input placeholder="Apt, suite, etc. (optional)" className="w-full border rounded px-3 py-2" value={form.line2} onChange={set("line2")} />
            <div className="grid grid-cols-3 gap-2">
              <input placeholder="City" className="border rounded px-3 py-2" value={form.city} onChange={set("city")} required />
              <input placeholder="State" className="border rounded px-3 py-2" value={form.state} onChange={set("state")} required maxLength={2} />
              <input placeholder="ZIP" className="border rounded px-3 py-2" value={form.zip} onChange={set("zip")} required />
            </div>
          </div>
        </fieldset>

        {error && <p className="text-red-600 text-sm">{error}</p>}
        {saved && <p className="text-green-600 text-sm">Profile saved.</p>}
        <button type="submit" disabled={submitting} className="w-full bg-blue-600 text-white rounded py-2 disabled:opacity-50">
          {submitting ? "Saving…" : "Save"}
        </button>
      </form>
    </div>
  );
}
