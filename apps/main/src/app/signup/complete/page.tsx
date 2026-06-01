"use client";

// §17.3 — Signup: provision workspace + collect full business profile in one step.
// After success the operator lands on /onboarding/legal — no separate profile step.

import { useState, useEffect, useRef } from "react";
import { TIMEZONES } from "@/lib/timezones";

export function buildWorkspaceUrl(
  slug: string,
  location: { protocol: string; hostname: string },
): string {
  return `${location.protocol}//${slug}.${location.hostname}/onboarding/legal`;
}

type TenantType = "byo_host" | "sub_host";

export default function SignupCompletePage(): React.ReactElement {
  const [form, setForm] = useState({
    display_name: "",
    legal_name: "",
    tenant_type: "byo_host" as TenantType,
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
  const [slug, setSlug] = useState("");
  const [slugChecking, setSlugChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [workspaceUrl, setWorkspaceUrl] = useState<string | null>(null);
  const suffixRef = useRef(0);

  // Auto-generate a unique slug whenever display_name changes.
  useEffect(() => {
    if (!form.display_name) { setSlug(""); return; }
    const base = form.display_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 55);
    if (!base) { setSlug(""); return; }

    setSlugChecking(true);
    suffixRef.current += 1;
    const myRound = suffixRef.current;

    const find = async () => {
      let candidate = base;
      let n = 2;
      while (n <= 99) {
        const res = await fetch(`/api/tenants/slug-check?candidate=${encodeURIComponent(candidate)}`);
        const data = await res.json() as { available?: boolean };
        if (myRound !== suffixRef.current) return; // stale — a newer name change fired
        if (data.available) { setSlug(candidate); setSlugChecking(false); return; }
        candidate = `${base}-${n}`;
        n++;
      }
      setSlug(base); // give up after 99 — let the server reject and user sees slug_taken
      setSlugChecking(false);
    };

    const t = setTimeout(find, 350);
    return () => clearTimeout(t);
  }, [form.display_name]);

  const set = (field: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (slugChecking || !slug) return;
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/signup/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name:  form.display_name,
          legal_name:    form.legal_name,
          slug,
          tenant_type:   form.tenant_type,
          support_email: form.support_email,
          support_phone: form.support_phone || undefined,
          timezone:      form.timezone,
          mailing_address: {
            line1:   form.line1,
            line2:   form.line2 || undefined,
            city:    form.city,
            state:   form.state,
            zip:     form.zip,
            country: form.country,
          },
        }),
      });

      const data = await res.json() as { slug?: string; error?: string };

      if (res.status === 201 && data.slug) {
        setWorkspaceUrl(buildWorkspaceUrl(data.slug, window.location));
        return;
      }
      if (res.status === 409 && data.error === "already_provisioned") {
        setError("Your workspace is already set up. Use the link on your workspace subdomain to continue.");
        return;
      }
      if (res.status === 401) {
        window.location.href = "/signup";
        return;
      }
      setError(data.error ?? "Something went wrong. Please try again.");
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (workspaceUrl) {
    return (
      <main style={centerStyle}>
        <div style={{ fontSize: 48, lineHeight: 1 }}>✓</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Your workspace is ready</h1>
        <p style={{ color: "#6b7280", maxWidth: 420, textAlign: "center", margin: 0 }}>
          Click below to continue setup. You&apos;ll be asked to sign in once more to establish
          your session on your workspace subdomain.
        </p>
        <a href={workspaceUrl} style={btnStyle}>Continue to your workspace →</a>
        <p style={{ fontSize: 12, color: "#9ca3af" }}>{workspaceUrl}</p>
      </main>
    );
  }

  const canSubmit =
    form.display_name.trim() &&
    form.legal_name.trim() &&
    slug &&
    !slugChecking &&
    form.support_email.trim() &&
    form.timezone &&
    form.line1.trim() && form.city.trim() && form.state.trim() && form.zip.trim() &&
    !submitting;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "40px 16px" }}>
      <div style={{ width: "100%", maxWidth: 520, margin: "0 auto" }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>Set up your agency</h1>
        <p style={{ color: "#6b7280", marginBottom: 32, fontSize: 14 }}>
          Fill this in once — your workspace will be ready to use immediately after.
        </p>

        <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <Section title="Agency">
            <Field label="Agency display name *">
              <input style={inputStyle} value={form.display_name} onChange={set("display_name")} required placeholder="Acme Travel" />
            </Field>
            <Field label="Legal business name *">
              <input style={inputStyle} value={form.legal_name} onChange={set("legal_name")} required placeholder="Acme Travel LLC" />
            </Field>
            <Field label="Workspace URL" hint={
              slugChecking ? "Checking availability…" :
              slug ? `✓ ${slug}.${typeof window !== "undefined" ? window.location.hostname : "…"}` : ""
            } hintColor={slug && !slugChecking ? "#16a34a" : "#6b7280"}>
              <input
                style={{ ...inputStyle, background: "#f9fafb", color: "#6b7280", cursor: "default" }}
                value={slug}
                readOnly
                placeholder="generated from agency name"
              />
            </Field>
            <Field label="Account type *">
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <RadioOption value="byo_host" checked={form.tenant_type === "byo_host"}
                  onChange={() => setForm((f) => ({ ...f, tenant_type: "byo_host" }))}
                  label="Independent agency (BYO host)"
                  description="I work with my own host agency or am a direct seller." />
                <RadioOption value="sub_host" checked={form.tenant_type === "sub_host"}
                  onChange={() => setForm((f) => ({ ...f, tenant_type: "sub_host" }))}
                  label="Sub-agency under a host"
                  description="I operate under a host agency that also uses this platform." />
              </div>
            </Field>
          </Section>

          <Section title="Contact & Support">
            <Field label="Support email *">
              <input type="email" style={inputStyle} value={form.support_email} onChange={set("support_email")} required placeholder="support@acmetravel.com" />
            </Field>
            <Field label="Support phone">
              <input style={inputStyle} value={form.support_phone} onChange={set("support_phone")} placeholder="+1 555 000 0000" />
            </Field>
            <Field label="Time zone *">
              <select style={inputStyle} value={form.timezone} onChange={set("timezone")} required>
                {TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>{tz.label} ({tz.offset})</option>
                ))}
              </select>
            </Field>
          </Section>

          <Section title="Mailing Address">
            <Field label="Street address *">
              <input style={inputStyle} value={form.line1} onChange={set("line1")} required placeholder="123 Main St" />
            </Field>
            <Field label="Apt, suite, etc.">
              <input style={inputStyle} value={form.line2} onChange={set("line2")} placeholder="Suite 100" />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 100px", gap: 10 }}>
              <Field label="City *">
                <input style={inputStyle} value={form.city} onChange={set("city")} required />
              </Field>
              <Field label="State *">
                <input style={inputStyle} value={form.state} onChange={set("state")} required maxLength={2} />
              </Field>
              <Field label="ZIP *">
                <input style={inputStyle} value={form.zip} onChange={set("zip")} required />
              </Field>
            </div>
          </Section>

          {error && <p style={{ color: "#dc2626", fontSize: 14, margin: 0 }}>{error}</p>}

          <button type="submit" disabled={!canSubmit} style={{
            padding: "12px 16px",
            background: canSubmit ? "#3b82f6" : "#93c5fd",
            color: "#fff", border: "none", borderRadius: 8,
            fontSize: 15, fontWeight: 600,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}>
            {submitting ? "Creating workspace…" : "Create workspace"}
          </button>
        </form>
      </div>
    </main>
  );
}

const centerStyle: React.CSSProperties = {
  display: "flex", flexDirection: "column", alignItems: "center",
  justifyContent: "center", minHeight: "100vh", gap: 24,
  fontFamily: "system-ui, sans-serif", padding: "0 16px",
};

const btnStyle: React.CSSProperties = {
  padding: "12px 28px", background: "#3b82f6", color: "#fff",
  borderRadius: 8, textDecoration: "none", fontSize: 15, fontWeight: 600,
};

const inputStyle: React.CSSProperties = {
  display: "block", width: "100%", padding: "10px 12px",
  border: "1px solid #d1d5db", borderRadius: 8, fontSize: 15, boxSizing: "border-box",
};

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <fieldset style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "16px 16px 8px" }}>
      <legend style={{ fontSize: 13, fontWeight: 600, color: "#374151", padding: "0 4px" }}>{title}</legend>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>
    </fieldset>
  );
}

function Field({ label, hint, hintColor, children }: {
  label: string; hint?: string; hintColor?: string; children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <label style={{ display: "block", fontSize: 14, fontWeight: 500, marginBottom: 6 }}>{label}</label>
      {children}
      {hint && <p style={{ fontSize: 12, color: hintColor ?? "#6b7280", margin: "4px 0 0" }}>{hint}</p>}
    </div>
  );
}

function RadioOption({ value, checked, onChange, label, description }: {
  value: string; checked: boolean; onChange: () => void; label: string; description: string;
}): React.ReactElement {
  return (
    <label style={{
      display: "flex", gap: 12, padding: "10px 12px",
      border: `1px solid ${checked ? "#3b82f6" : "#d1d5db"}`,
      borderRadius: 8, cursor: "pointer",
      background: checked ? "#eff6ff" : "#fff",
    }}>
      <input type="radio" name="tenant_type" value={value} checked={checked} onChange={onChange} style={{ marginTop: 2, flexShrink: 0 }} />
      <div>
        <p style={{ margin: 0, fontWeight: 500, fontSize: 14 }}>{label}</p>
        <p style={{ margin: "2px 0 0", fontSize: 13, color: "#6b7280" }}>{description}</p>
      </div>
    </label>
  );
}
