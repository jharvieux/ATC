"use client";

// §17.3 — Signup: provision workspace + collect full business profile in one step.
// After success the operator lands on /onboarding/legal — no separate profile step.

import { useState, useEffect, useRef } from "react";
import { TIMEZONES } from "@/lib/timezones";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
      if (res.status === 409 && data.error === "slug_taken") {
        setError("That workspace name is already taken. Please change your agency display name and try again.");
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
      <main className="flex flex-col items-center justify-center min-h-screen gap-6 p-4">
        <div className="text-5xl leading-none">✓</div>
        <h1 className="text-2xl font-bold">Your workspace is ready</h1>
        <p className="text-muted-foreground text-sm max-w-sm text-center">
          Click below to continue setup. You&apos;ll be asked to sign in once more to establish
          your session on your workspace subdomain.
        </p>
        <a
          href={workspaceUrl}
          className="inline-flex items-center justify-center rounded-md text-sm font-semibold bg-primary text-primary-foreground hover:bg-primary/90 px-7 py-3"
        >
          Continue to your workspace →
        </a>
        <p className="text-xs text-muted-foreground">{workspaceUrl}</p>
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
    <main className="py-10 px-4">
      <div className="w-full max-w-lg mx-auto">
        <h1 className="text-2xl font-bold mb-2">Set up your agency</h1>
        <p className="text-muted-foreground text-sm mb-8">
          Fill this in once — your workspace will be ready to use immediately after.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <Section title="Agency">
            <Field label="Agency display name *">
              <Input value={form.display_name} onChange={set("display_name")} required placeholder="Acme Travel" />
            </Field>
            <Field label="Legal business name *">
              <Input value={form.legal_name} onChange={set("legal_name")} required placeholder="Acme Travel LLC" />
            </Field>
            <Field
              label="Workspace URL"
              hint={
                slugChecking ? "Checking availability…" :
                slug ? `✓ ${slug}.${typeof window !== "undefined" ? window.location.hostname : "…"}` : ""
              }
              hintVariant={slug && !slugChecking ? "success" : "default"}
            >
              <Input
                value={slug}
                readOnly
                placeholder="generated from agency name"
                className="bg-muted text-muted-foreground cursor-default"
              />
            </Field>
            <Field label="Account type *">
              <div className="flex flex-col gap-2.5">
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
              <Input type="email" value={form.support_email} onChange={set("support_email")} required placeholder="support@acmetravel.com" />
            </Field>
            <Field label="Support phone">
              <Input value={form.support_phone} onChange={set("support_phone")} placeholder="+1 555 000 0000" />
            </Field>
            <Field label="Time zone *">
              <select
                value={form.timezone}
                onChange={set("timezone")}
                required
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>{tz.label} ({tz.offset})</option>
                ))}
              </select>
            </Field>
          </Section>

          <Section title="Mailing Address">
            <Field label="Street address *">
              <Input value={form.line1} onChange={set("line1")} required placeholder="123 Main St" />
            </Field>
            <Field label="Apt, suite, etc.">
              <Input value={form.line2} onChange={set("line2")} placeholder="Suite 100" />
            </Field>
            <div className="grid gap-2.5 [grid-template-columns:1fr_80px_100px]">
              <Field label="City *">
                <Input value={form.city} onChange={set("city")} required />
              </Field>
              <Field label="State *">
                <Input value={form.state} onChange={set("state")} required maxLength={2} />
              </Field>
              <Field label="ZIP *">
                <Input value={form.zip} onChange={set("zip")} required />
              </Field>
            </div>
          </Section>

          {error && <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>}

          <Button type="submit" disabled={!canSubmit}>
            {submitting ? "Creating workspace…" : "Create workspace"}
          </Button>
        </form>
      </div>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <fieldset className="border border-border rounded-lg p-4 pb-2 min-w-0">
      <legend className="text-xs font-semibold text-foreground px-1">{title}</legend>
      <div className="flex flex-col gap-3.5">{children}</div>
    </fieldset>
  );
}

function Field({ label, hint, hintVariant = "default", children }: {
  label: string; hint?: string; hintVariant?: "default" | "success"; children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <label className="block text-sm font-medium mb-1.5">{label}</label>
      {children}
      {hint && (
        <p className={`text-xs mt-1 ${hintVariant === "success" ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>
          {hint}
        </p>
      )}
    </div>
  );
}

function RadioOption({ value, checked, onChange, label, description }: {
  value: string; checked: boolean; onChange: () => void; label: string; description: string;
}): React.ReactElement {
  return (
    <label className={`flex gap-3 p-3 border rounded-lg cursor-pointer ${checked ? "border-primary bg-primary/5" : "border-border bg-background"}`}>
      <input type="radio" name="tenant_type" value={value} checked={checked} onChange={onChange} className="mt-0.5 shrink-0" />
      <div>
        <p className="font-medium text-sm">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
    </label>
  );
}
