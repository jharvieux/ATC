"use client";

// §15.3 — Onboarding Stage 2: Profile
// USPS address validation: TODO(usps-validator) — stubbed for Phase 1.

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { TIMEZONES } from "@/lib/timezones";

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
  const [slugAvailable, setSlugAvailable] = useState<boolean | null>(null);
  const [slugChecking, setSlugChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Auto-suggest slug from display name.
  useEffect(() => {
    const suggested = form.display_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 63);
    setForm((f) => ({ ...f, slug: suggested }));
  }, [form.display_name]);

  // Debounced slug check.
  useEffect(() => {
    if (!form.slug || form.slug.length < 3) {
      setSlugAvailable(null);
      return;
    }
    setSlugChecking(true);
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/tenants/slug-check?candidate=${encodeURIComponent(form.slug)}`);
      const data = await res.json();
      setSlugAvailable(data.available ?? false);
      setSlugChecking(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [form.slug]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!slugAvailable) return;

    setSubmitting(true);
    setError(null);

    const res = await fetch("/api/onboarding/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        legal_name: form.legal_name,
        display_name: form.display_name,
        slug: form.slug,
        mailing_address: { line1: form.line1, line2: form.line2 || undefined, city: form.city, state: form.state, zip: form.zip, country: form.country },
        support_email: form.support_email,
        support_phone: form.support_phone || undefined,
        timezone: form.timezone,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Submission failed");
      setSubmitting(false);
      return;
    }

    router.push("/onboarding/legal");
  }

  const set = (field: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <h1 className="text-2xl font-semibold mb-6">Business Profile</h1>
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
          <label className="block text-sm font-medium mb-1">URL Slug *</label>
          <input className="w-full border rounded px-3 py-2" value={form.slug} onChange={set("slug")} pattern="[a-z0-9\-]{3,63}" required />
          {slugChecking && <p className="text-xs text-gray-500 mt-1">Checking…</p>}
          {!slugChecking && slugAvailable === true && <p className="text-xs text-green-600 mt-1">Available</p>}
          {!slugChecking && slugAvailable === false && <p className="text-xs text-red-600 mt-1">Not available</p>}
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
        <button
          type="submit"
          disabled={submitting || !slugAvailable}
          className="w-full bg-blue-600 text-white rounded py-2 disabled:opacity-50"
        >
          {submitting ? "Saving…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
