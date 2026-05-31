"use client";

// §17.3 — Company info collection step (platform domain, post-OAuth).

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

type TenantType = "byo_host" | "sub_host";

// Exported for unit testing. After provisioning, the operator lands on the
// tenant subdomain's first onboarding step — NOT the platform domain.
export function buildWorkspaceUrl(
  slug: string,
  location: { protocol: string; hostname: string },
): string {
  return `${location.protocol}//${slug}.${location.hostname}/onboarding/profile`;
}

export default function SignupCompletePage(): React.ReactElement {
  const router = useRouter();
  const [form, setForm] = useState({
    display_name: "",
    legal_name: "",
    slug: "",
    tenant_type: "byo_host" as TenantType,
  });
  const [slugAvailable, setSlugAvailable] = useState<boolean | null>(null);
  const [slugChecking, setSlugChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [workspaceUrl, setWorkspaceUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!form.display_name) return;
    const suggested = form.display_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 63);
    setForm((f) => ({ ...f, slug: suggested }));
  }, [form.display_name]);

  useEffect(() => {
    if (!form.slug || form.slug.length < 3) {
      setSlugAvailable(null);
      return;
    }
    setSlugChecking(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/tenants/slug-check?candidate=${encodeURIComponent(form.slug)}`,
        );
        const data: { available?: boolean } = await res.json();
        setSlugAvailable(data.available ?? false);
      } catch {
        setSlugAvailable(false);
      } finally {
        setSlugChecking(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [form.slug]);

  const setText =
    (field: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!slugAvailable) return;

    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/signup/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const data: { slug?: string; error?: string } = await res.json();

      if (res.status === 201 && data.slug) {
        setWorkspaceUrl(buildWorkspaceUrl(data.slug, window.location));
        return;
      }

      if (res.status === 409 && data.error === "already_provisioned") {
        setError(
          "Your agency workspace is already set up. Visit your agency subdomain to continue onboarding.",
        );
        return;
      }

      if (res.status === 409 && data.error === "slug_taken") {
        setSlugAvailable(false);
        setError("That URL slug is already taken. Please choose a different one.");
        return;
      }

      if (res.status === 401) {
        router.push("/signup");
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
      <main
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          gap: 24,
          fontFamily: "system-ui, sans-serif",
          padding: "0 16px",
        }}
      >
        <div
          style={{
            fontSize: 48,
            lineHeight: 1,
          }}
        >
          ✓
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>
          Your workspace is ready
        </h1>
        <p
          style={{
            color: "#6b7280",
            maxWidth: 420,
            textAlign: "center",
            margin: 0,
          }}
        >
          Click below to continue setting up your agency. You&apos;ll be asked
          to sign in once more to establish your session on your workspace
          subdomain.
        </p>
        <a
          href={workspaceUrl}
          style={{
            padding: "12px 28px",
            background: "#3b82f6",
            color: "#fff",
            borderRadius: 8,
            textDecoration: "none",
            fontSize: 15,
            fontWeight: 600,
          }}
        >
          Continue to your workspace →
        </a>
        <p style={{ fontSize: 12, color: "#9ca3af" }}>{workspaceUrl}</p>
      </main>
    );
  }

  const canSubmit =
    form.display_name.trim() &&
    form.legal_name.trim() &&
    form.slug.length >= 3 &&
    slugAvailable === true &&
    !submitting;

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        fontFamily: "system-ui, sans-serif",
        padding: "40px 16px",
      }}
    >
      <div style={{ width: "100%", maxWidth: 480 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
          Set up your agency
        </h1>
        <p style={{ color: "#6b7280", marginBottom: 32, fontSize: 14 }}>
          This creates your workspace. You can update these details later.
        </p>

        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", gap: 20 }}
        >
          <Field label="Agency display name *">
            <input
              type="text"
              value={form.display_name}
              onChange={setText("display_name")}
              required
              placeholder="Acme Travel"
              style={inputStyle}
            />
          </Field>

          <Field label="Legal business name *">
            <input
              type="text"
              value={form.legal_name}
              onChange={setText("legal_name")}
              required
              placeholder="Acme Travel LLC"
              style={inputStyle}
            />
          </Field>

          <Field
            label="Workspace URL *"
            {...(slugChecking
              ? { hint: "Checking…" }
              : slugAvailable === true
                ? { hint: "✓ Available", hintColor: "#16a34a" }
                : slugAvailable === false
                  ? { hint: "Not available", hintColor: "#dc2626" }
                  : {})}
          >
            <input
              type="text"
              value={form.slug}
              onChange={setText("slug")}
              required
              pattern="[a-z0-9\-]{3,63}"
              placeholder="acme-travel"
              style={inputStyle}
            />
          </Field>

          <Field label="Account type *">
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <RadioOption
                value="byo_host"
                checked={form.tenant_type === "byo_host"}
                onChange={() =>
                  setForm((f) => ({ ...f, tenant_type: "byo_host" }))
                }
                label="Independent agency (BYO host)"
                description="I work with my own host agency or am a direct seller."
              />
              <RadioOption
                value="sub_host"
                checked={form.tenant_type === "sub_host"}
                onChange={() =>
                  setForm((f) => ({ ...f, tenant_type: "sub_host" }))
                }
                label="Sub-agency under a host"
                description="I operate under a host agency that also uses this platform."
              />
            </div>
          </Field>

          {error && (
            <p style={{ color: "#dc2626", fontSize: 14, margin: 0 }}>
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!canSubmit}
            style={{
              padding: "12px 16px",
              background: canSubmit ? "#3b82f6" : "#93c5fd",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontSize: 15,
              fontWeight: 600,
              cursor: canSubmit ? "pointer" : "not-allowed",
              marginTop: 8,
            }}
          >
            {submitting ? "Creating workspace…" : "Create workspace"}
          </button>
        </form>
      </div>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "10px 12px",
  border: "1px solid #d1d5db",
  borderRadius: 8,
  fontSize: 15,
  boxSizing: "border-box",
};

function Field({
  label,
  hint,
  hintColor,
  children,
}: {
  label: string;
  hint?: string;
  hintColor?: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div>
      <label style={{ display: "block", fontSize: 14, fontWeight: 500, marginBottom: 6 }}>
        {label}
      </label>
      {children}
      {hint && (
        <p style={{ fontSize: 12, color: hintColor ?? "#6b7280", margin: "4px 0 0" }}>
          {hint}
        </p>
      )}
    </div>
  );
}

function RadioOption({
  value,
  checked,
  onChange,
  label,
  description,
}: {
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
}): React.ReactElement {
  return (
    <label
      style={{
        display: "flex",
        gap: 12,
        padding: "12px 14px",
        border: `1px solid ${checked ? "#3b82f6" : "#d1d5db"}`,
        borderRadius: 8,
        cursor: "pointer",
        background: checked ? "#eff6ff" : "#fff",
      }}
    >
      <input
        type="radio"
        name="tenant_type"
        value={value}
        checked={checked}
        onChange={onChange}
        style={{ marginTop: 2, flexShrink: 0 }}
      />
      <div>
        <p style={{ margin: 0, fontWeight: 500, fontSize: 14 }}>{label}</p>
        <p style={{ margin: "2px 0 0", fontSize: 13, color: "#6b7280" }}>
          {description}
        </p>
      </div>
    </label>
  );
}
