"use client";

// D-138 §9.3 — Platform-admin persona editor.
//
// Three things on one page:
//   1. Persona list (GET /api/admin/personas) → pick one to edit.
//   2. Structured editor for the selected persona (GET/PUT
//      /api/admin/personas/[slug], POST .../restore). Every editable field has
//      its own input; the prompt is assembled deterministically from them.
//   3. The Layer-2 safety block (GET/PUT /api/admin/persona-safety, POST
//      .../restore). The legal kernel is shown READ-ONLY — it is code-enforced
//      and cannot be edited here; only the safety block below it is editable.
//
// Auth is enforced by the (admin) layout + per-route on /api/admin/*; this page
// just fetches via adminFetch (HttpOnly session cookie travels automatically).

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-fetch";

type PersonaListItem = {
  slug: string;
  kind: string;
  display_name: string;
  tagline: string | null;
  specialty: string | null;
  is_active: boolean;
  sort_order: number;
  version: number;
};

type PersonaDetail = { slug: string; kind: string; version: number } & Record<string, unknown>;

type SafetyConfig = {
  legal_kernel: string;
  editable_block: string;
  version: number;
  default_editable_block: string;
};

type FieldKind = "text" | "textarea" | "lines";
const PLATFORM_HELP_KIND = "platform_help";

// One row per editable column. `lines` = a string[] edited one-per-line
// (anti_instructions). Order is the on-screen order.
const FIELD_DEFS: { key: string; label: string; kind: FieldKind; required?: boolean }[] = [
  { key: "display_name", label: "Display name", kind: "text", required: true },
  { key: "tagline", label: "Tagline", kind: "text" },
  { key: "specialty", label: "Specialty", kind: "text" },
  { key: "background", label: "Background", kind: "textarea" },
  { key: "voice", label: "Voice", kind: "text" },
  { key: "tone_style", label: "Tone style", kind: "text" },
  { key: "expertise_primary", label: "Expertise — primary", kind: "text" },
  { key: "expertise_secondary", label: "Expertise — secondary", kind: "text" },
  { key: "expertise_fallback_note", label: "Expertise — fallback note", kind: "text" },
  { key: "anti_instructions", label: "Anti-instructions (one per line)", kind: "lines" },
  { key: "disclosure_pattern", label: "Disclosure pattern", kind: "text" },
  { key: "prompt_body", label: "Prompt body", kind: "textarea", required: true },
];

function personaToDraft(p: PersonaDetail): Record<string, string> {
  const d: Record<string, string> = {};
  for (const f of FIELD_DEFS) {
    const v = p[f.key];
    if (f.kind === "lines") d[f.key] = Array.isArray(v) ? (v as string[]).join("\n") : "";
    else d[f.key] = v == null ? "" : String(v);
  }
  return d;
}

// Builds the full PUT patch. Empty nullable fields → null; background stays a
// plain string (may be ""); required fields pass through (server re-validates
// non-empty); anti_instructions splits to a trimmed, non-empty string[].
function draftToPatch(draft: Record<string, string>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const f of FIELD_DEFS) {
    const raw = draft[f.key] ?? "";
    if (f.kind === "lines") {
      patch[f.key] = raw.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
    } else if (f.key === "background" || f.required) {
      patch[f.key] = raw;
    } else {
      patch[f.key] = raw.trim() === "" ? null : raw;
    }
  }
  return patch;
}

const inputStyle: React.CSSProperties = { width: "100%", padding: 6, fontFamily: "inherit", fontSize: 13 };
const labelStyle: React.CSSProperties = { display: "block", fontWeight: 600, fontSize: 13, marginBottom: 4, marginTop: 14 };

export default function AdminPersonasPage(): JSX.Element {
  const [personas, setPersonas] = useState<PersonaListItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PersonaDetail | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [safety, setSafety] = useState<SafetyConfig | null>(null);
  const [safetyDraft, setSafetyDraft] = useState<string>("");

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function loadList(): Promise<void> {
    const res = await adminFetch("/api/admin/personas");
    if (!res.ok) throw new Error(`persona list failed: ${res.status}`);
    const body = (await res.json()) as { personas: PersonaListItem[] };
    setPersonas(body.personas);
  }

  async function loadSafety(): Promise<void> {
    const res = await adminFetch("/api/admin/persona-safety");
    if (!res.ok) throw new Error(`safety config failed: ${res.status}`);
    const body = (await res.json()) as SafetyConfig;
    setSafety(body);
    setSafetyDraft(body.editable_block);
  }

  useEffect(() => {
    void (async () => {
      try {
        await Promise.all([loadList(), loadSafety()]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function openEditor(slug: string): Promise<void> {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await adminFetch(`/api/admin/personas/${slug}`);
      if (!res.ok) throw new Error(`load ${slug} failed: ${res.status}`);
      const body = (await res.json()) as { persona: PersonaDetail };
      setDetail(body.persona);
      setDraft(personaToDraft(body.persona));
      setSelected(slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function closeEditor(): void {
    setSelected(null);
    setDetail(null);
    setDraft({});
    setMsg(null);
    setError(null);
  }

  async function savePersona(): Promise<void> {
    if (!selected) return;
    if ((draft.display_name ?? "").trim() === "" || (draft.prompt_body ?? "").trim() === "") {
      setError("Display name and prompt body are required.");
      return;
    }
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await adminFetch(`/api/admin/personas/${selected}`, {
        method: "PUT",
        body: JSON.stringify(draftToPatch(draft)),
      });
      const parsed = (await res.json()) as { ok?: boolean; version?: number; error?: string; field?: string };
      if (!res.ok) throw new Error(parsed.field ? `${parsed.error} (${parsed.field})` : parsed.error ?? "save failed");
      setMsg(`Saved — now at version ${parsed.version}.`);
      await Promise.all([loadList(), openEditor(selected)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function restorePersona(): Promise<void> {
    if (!selected) return;
    if (!window.confirm(`Restore "${selected}" to its built-in default? This overwrites all fields.`)) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await adminFetch(`/api/admin/personas/${selected}/restore`, { method: "POST" });
      const parsed = (await res.json()) as { ok?: boolean; version?: number; error?: string };
      if (!res.ok) throw new Error(parsed.error ?? "restore failed");
      setMsg(`Restored to default — now at version ${parsed.version}.`);
      await Promise.all([loadList(), openEditor(selected)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveSafety(): Promise<void> {
    if (safetyDraft.trim() === "") {
      setError("The safety block cannot be empty.");
      return;
    }
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await adminFetch("/api/admin/persona-safety", {
        method: "PUT",
        body: JSON.stringify({ editable_block: safetyDraft }),
      });
      const parsed = (await res.json()) as { ok?: boolean; version?: number; error?: string };
      if (!res.ok) throw new Error(parsed.error ?? "save failed");
      setMsg(`Safety block saved — now at version ${parsed.version}.`);
      await loadSafety();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function restoreSafety(): Promise<void> {
    if (!window.confirm("Restore the safety block to its built-in default?")) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await adminFetch("/api/admin/persona-safety/restore", { method: "POST" });
      const parsed = (await res.json()) as { ok?: boolean; version?: number; error?: string };
      if (!res.ok) throw new Error(parsed.error ?? "restore failed");
      setMsg(`Safety block restored — now at version ${parsed.version}.`);
      await loadSafety();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>Loading…</main>;

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "32px 24px", maxWidth: 880, margin: "0 auto" }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>Personas</h1>
      <p style={{ color: "#6b7280", fontSize: 14, marginBottom: 24 }}>
        Edit the DB-backed persona definitions and the shared safety block. Changes take effect on the
        next chat turn (a 60-second cache may briefly serve the prior version).
      </p>

      {error && <p style={{ color: "crimson", fontSize: 14 }}>{error}</p>}
      {msg && <p style={{ color: "green", fontSize: 14 }}>{msg}</p>}

      {selected && detail ? (
        <section>
          <button onClick={closeEditor} disabled={busy} style={{ marginBottom: 16 }}>
            ← Back to list
          </button>
          <h2 style={{ fontSize: 18, fontWeight: 700 }}>
            {detail.slug} <span style={{ color: "#9ca3af", fontWeight: 400, fontSize: 13 }}>({detail.kind}, v{detail.version})</span>
          </h2>
          {detail.kind === PLATFORM_HELP_KIND && (
            <p style={{ color: "#b45309", fontSize: 13 }}>
              This is the platform Help persona — only Display name and Prompt body shape its prompt; the
              other fields are not applied.
            </p>
          )}

          {FIELD_DEFS.map((f) => (
            <label key={f.key} style={labelStyle}>
              {f.label}
              {f.required && <span style={{ color: "crimson" }}> *</span>}
              {f.kind === "text" ? (
                <input
                  type="text"
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  disabled={busy}
                  style={inputStyle}
                />
              ) : (
                <textarea
                  value={draft[f.key] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  disabled={busy}
                  rows={f.kind === "lines" ? 5 : f.key === "prompt_body" ? 16 : 4}
                  style={{ ...inputStyle, fontFamily: f.key === "prompt_body" ? "monospace" : "inherit" }}
                />
              )}
            </label>
          ))}

          <div style={{ marginTop: 20, display: "flex", gap: 12 }}>
            <button onClick={() => void savePersona()} disabled={busy}>
              {busy ? "Working…" : "Save"}
            </button>
            <button onClick={() => void restorePersona()} disabled={busy}>
              Restore to default
            </button>
          </div>
        </section>
      ) : (
        <section>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {["Name", "Slug", "Kind", "Active", "Order", "Ver", ""].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "6px 10px", borderBottom: "1px solid #ccc", fontSize: 12, color: "#6b7280" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(personas ?? []).map((p) => (
                <tr key={p.slug}>
                  <td style={{ padding: "6px 10px", borderBottom: "1px solid #eee", fontWeight: 600 }}>{p.display_name}</td>
                  <td style={{ padding: "6px 10px", borderBottom: "1px solid #eee", fontFamily: "monospace", fontSize: 12 }}>{p.slug}</td>
                  <td style={{ padding: "6px 10px", borderBottom: "1px solid #eee", fontSize: 12, color: "#6b7280" }}>{p.kind}</td>
                  <td style={{ padding: "6px 10px", borderBottom: "1px solid #eee" }}>{p.is_active ? "yes" : "no"}</td>
                  <td style={{ padding: "6px 10px", borderBottom: "1px solid #eee" }}>{p.sort_order}</td>
                  <td style={{ padding: "6px 10px", borderBottom: "1px solid #eee" }}>{p.version}</td>
                  <td style={{ padding: "6px 10px", borderBottom: "1px solid #eee" }}>
                    <button onClick={() => void openEditor(p.slug)} disabled={busy}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 style={{ fontSize: 18, fontWeight: 700, marginTop: 40 }}>Safety block (Layer 2)</h2>
          <p style={{ color: "#6b7280", fontSize: 13 }}>
            Appended to every persona prompt. The legal kernel below is code-enforced and read-only; only the
            editable section beneath it can be changed.
          </p>

          {safety && (
            <>
              <label style={labelStyle}>Legal kernel (read-only — code-enforced)</label>
              <textarea
                value={safety.legal_kernel}
                readOnly
                rows={12}
                style={{ ...inputStyle, fontFamily: "monospace", background: "#f9fafb", color: "#374151" }}
              />

              <label style={labelStyle}>
                Editable safety block <span style={{ color: "#9ca3af", fontWeight: 400 }}>(v{safety.version})</span>
              </label>
              <textarea
                value={safetyDraft}
                onChange={(e) => setSafetyDraft(e.target.value)}
                disabled={busy}
                rows={14}
                style={{ ...inputStyle, fontFamily: "monospace" }}
              />

              <div style={{ marginTop: 16, display: "flex", gap: 12 }}>
                <button onClick={() => void saveSafety()} disabled={busy}>
                  {busy ? "Working…" : "Save safety block"}
                </button>
                <button onClick={() => void restoreSafety()} disabled={busy}>
                  Restore to default
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}
