"use client";

// Agent-console redesign — "Draft a reply" rendered as an inline tab,
// not a separate route. Logic mirrors apps/main/src/app/(tenant)/concierge/draft/page.tsx
// but the agent is controlled by the parent (ConciergeExperience), and the
// tone chip row is surfaced directly. Nothing is sent — copy-only contract.

import { useCallback, useState } from "react";
import { AgentAvatar } from "./AgentPickerPopover";
import { AGENT_CATALOG } from "@/lib/agents/catalog";
import { parseEmlFile, parseMsgFile, type ParsedInquiry } from "@/lib/draft/parse-inquiry";
import { deriveGreetingName } from "@/lib/draft/greeting-name";
import { Copy, RefreshCw } from "lucide-react";

type Tone = "Warm" | "Concise" | "Detailed" | "Reassuring";
const TONES: Tone[] = ["Warm", "Concise", "Detailed", "Reassuring"];

// Exported for unit testing — resolves which fields to populate from a
// parsed email, encoding the customerName-only-if-empty invariant and the
// null-body (.msg RTF-fail) contract in one testable place.
export function resolveEmailDrop(
  parsed: ParsedInquiry,
  currentCustomerName: string,
): { inquiry: string | null; customerName: string | null } {
  const greetingName = deriveGreetingName(parsed.from_name, parsed.from_email);
  return {
    inquiry: parsed.body,
    customerName: greetingName && !currentCustomerName ? greetingName : null,
  };
}

interface InlineDraftViewProps {
  agentSlug: string;
}

export function InlineDraftView({ agentSlug }: InlineDraftViewProps): React.JSX.Element {
  const [inquiry, setInquiry] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [tone, setTone] = useState<Tone>("Warm");
  const [generating, setGenerating] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [voiceMissing, setVoiceMissing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dragHover, setDragHover] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragHover(false);
    setDropError(null);
    try {
      const file = e.dataTransfer.files?.[0];
      if (file) {
        const fileName = file.name.toLowerCase();
        const buf = await file.arrayBuffer();
        let parsed;
        if (fileName.endsWith(".eml")) {
          parsed = await parseEmlFile(buf);
        } else if (fileName.endsWith(".msg")) {
          parsed = await parseMsgFile(buf);
          if (!parsed.body) setDropError("Couldn't extract text from this .msg — paste the body below.");
        } else {
          setDropError("Drop a .eml or .msg file, or drag the email text itself.");
          return;
        }
        const { inquiry: body, customerName: name } = resolveEmailDrop(parsed, customerName);
        if (body) setInquiry(body);
        if (name) setCustomerName(name);
        return;
      }
      // safe: result is stored in React state, never rendered as HTML
      const text = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text/html").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (text.trim()) { setInquiry(text.trim()); return; }
      setDropError("Nothing readable in that drop — try the email file or drag its text.");
    } catch (err) {
      setDropError(err instanceof Error ? err.message : String(err));
    }
  }, [customerName]);

  const agent = AGENT_CATALOG.find((a) => a.slug === agentSlug) ?? AGENT_CATALOG[0]!;

  async function generate(): Promise<void> {
    setGenerating(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/draft-reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inquiry,
          customer_name: customerName || null,
          persona_slug: agentSlug,
          tone,
        }),
      });
      if (res.status === 403) {
        setError("Access restricted — drafting requires Owner or Agent role.");
        return;
      }
      const data = (await res.json()) as {
        draft?: string;
        error?: string;
        voice_profile_missing?: boolean;
      };
      if (!res.ok || !data.draft) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setDraft(data.draft);
      setVoiceMissing(Boolean(data.voice_profile_missing));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function copyDraft(): Promise<void> {
    await navigator.clipboard.writeText(draft);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  const taField: React.CSSProperties = {
    width: "100%",
    background: "var(--ta-surface-2)",
    border: "1px solid var(--ta-border-2)",
    borderRadius: "var(--ta-r-sm, 9px)",
    padding: "10px 12px",
    fontSize: 13,
    color: "var(--ta-text)",
    outline: "none",
    resize: "vertical" as const,
    fontFamily: "inherit",
    lineHeight: 1.5,
    boxSizing: "border-box" as const,
  };

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "24px 28px",
        maxWidth: 780,
        margin: "0 auto",
        width: "100%",
        boxSizing: "border-box",
      }}
    >
      {/* Header */}
      <h2
        style={{
          fontSize: 17,
          fontWeight: 700,
          color: "var(--ta-text)",
          margin: "0 0 4px",
        }}
      >
        Draft a reply
      </h2>
      <p style={{ fontSize: 12, color: "var(--ta-text-mute)", margin: "0 0 24px", lineHeight: 1.5 }}>
        Turns this conversation into a client-ready message in your voice — stays here as a tab,
        no screen switch.
      </p>

      {/* Customer name */}
      <div style={{ marginBottom: 14 }}>
        <label
          style={{ fontSize: 11, fontWeight: 600, color: "var(--ta-text-mute)", display: "block", marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.5 }}
        >
          Customer first name
        </label>
        <input
          type="text"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          placeholder="[name] if left blank"
          style={{ ...taField, resize: undefined }}
        />
      </div>

      <div style={{ marginBottom: 14 }}>
        <label
          style={{ fontSize: 11, fontWeight: 600, color: "var(--ta-text-mute)", display: "block", marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.5 }}
        >
          Customer email or inquiry
        </label>
        <div style={{ position: "relative" }}>
          <textarea
            value={inquiry}
            onChange={(e) => setInquiry(e.target.value)}
            onDragOver={(e) => { e.preventDefault(); setDragHover(true); }}
            onDragLeave={() => setDragHover(false)}
            onDrop={(e) => void handleDrop(e)}
            rows={6}
            placeholder="Paste the customer's email — or drag a .eml / .msg file here"
            style={{
              ...taField,
              border: `1px solid ${dragHover ? "var(--ta-accent)" : "var(--ta-border-2)"}`,
              background: dragHover ? "var(--ta-accent-soft, color-mix(in srgb, var(--ta-accent) 8%, transparent))" : undefined,
            }}
          />
          {dragHover && (
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "var(--ta-accent)", pointerEvents: "none", fontWeight: 600 }}>
              Drop to fill
            </div>
          )}
        </div>
        {dropError && <p style={{ fontSize: 12, color: "#F87171", marginTop: 4 }}>{dropError}</p>}
      </div>

      {/* Tone chips */}
      <div style={{ marginBottom: 20 }}>
        <div
          style={{ fontSize: 11, fontWeight: 600, color: "var(--ta-text-mute)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}
        >
          Tone
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {TONES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTone(t)}
              style={{
                padding: "5px 14px",
                borderRadius: 20,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                border: `1px solid ${t === tone ? "var(--ta-accent)" : "var(--ta-border-2)"}`,
                background: t === tone ? "var(--ta-accent-soft)" : "transparent",
                color: t === tone ? "var(--ta-accent)" : "var(--ta-text-soft)",
                transition: "all 0.12s",
              }}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Byline + generate button */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          padding: "10px 14px",
          background: "var(--ta-surface)",
          border: "1px solid var(--ta-border)",
          borderRadius: "var(--ta-r, 13px)",
        }}
      >
        <AgentAvatar agent={agent} size={26} />
        <span style={{ fontSize: 12, color: "var(--ta-text-soft)", flex: 1 }}>
          Drafting as <span style={{ color: "var(--ta-text)", fontWeight: 600 }}>{agent.name}</span>
        </span>
        <button
          type="button"
          onClick={() => void generate()}
          disabled={generating || !inquiry.trim()}
          style={{
            padding: "7px 18px",
            borderRadius: "var(--ta-r-sm, 9px)",
            fontSize: 13,
            fontWeight: 600,
            cursor: generating || !inquiry.trim() ? "not-allowed" : "pointer",
            border: "none",
            background:
              generating || !inquiry.trim() ? "var(--ta-surface-2)" : "var(--ta-accent)",
            color:
              generating || !inquiry.trim() ? "var(--ta-text-mute)" : "var(--ta-accent-ink)",
            transition: "background 0.15s",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {generating && (
            <RefreshCw
              size={12}
              style={{ animation: "spin 1s linear infinite" }}
            />
          )}
          {generating ? "Drafting…" : draft ? "Regenerate" : "Draft reply"}
        </button>
      </div>

      {error && (
        <p style={{ fontSize: 12, color: "#F87171", marginBottom: 12 }}>{error}</p>
      )}

      {/* Output card */}
      {draft && (
        <div
          style={{
            background: "var(--ta-surface)",
            border: "1px solid var(--ta-border-2)",
            borderRadius: "var(--ta-r, 13px)",
            overflow: "hidden",
          }}
        >
          {/* Card header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 14px",
              borderBottom: "1px solid var(--ta-border)",
              background: "var(--ta-surface-2)",
            }}
          >
            <AgentAvatar agent={agent} size={22} />
            <span style={{ fontSize: 12, color: "var(--ta-text-soft)", flex: 1 }}>
              Suggested reply ·{" "}
              <span style={{ color: "var(--ta-text)" }}>in your voice</span>
            </span>
            <span
              style={{
                fontSize: 10,
                padding: "2px 8px",
                background: "var(--ta-accent-soft)",
                color: "var(--ta-accent)",
                borderRadius: 12,
                fontWeight: 600,
                letterSpacing: 0.4,
              }}
            >
              Ready to send
            </span>
          </div>

          {voiceMissing && (
            <div
              style={{
                fontSize: 12,
                color: "var(--ta-amber)",
                padding: "8px 14px",
                borderBottom: "1px solid var(--ta-border)",
                background: "rgba(240,180,90,.08)",
              }}
            >
              No voice profile yet — this draft uses a neutral tone.{" "}
              <a href="/settings/voice" style={{ color: "var(--ta-accent)" }}>
                Add samples
              </a>{" "}
              so drafts sound like you.
            </div>
          )}

          {/* Draft body */}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={12}
            style={{
              ...taField,
              border: "none",
              borderRadius: 0,
              background: "var(--ta-surface)",
              resize: "vertical",
            }}
          />

          {/* Footer actions */}
          <div
            style={{
              display: "flex",
              gap: 8,
              padding: "10px 14px",
              borderTop: "1px solid var(--ta-border)",
            }}
          >
            <button
              type="button"
              onClick={() => void copyDraft()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 14px",
                borderRadius: "var(--ta-r-sm, 9px)",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                border: "1px solid var(--ta-border-2)",
                background: copied ? "var(--ta-accent-soft)" : "transparent",
                color: copied ? "var(--ta-accent)" : "var(--ta-text-soft)",
                transition: "all 0.12s",
              }}
            >
              <Copy size={12} />
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <a
              href={`mailto:?body=${encodeURIComponent(draft)}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 14px",
                borderRadius: "var(--ta-r-sm, 9px)",
                fontSize: 12,
                fontWeight: 500,
                textDecoration: "none",
                border: "1px solid var(--ta-border-2)",
                color: "var(--ta-text-soft)",
              }}
            >
              Open in email
            </a>
            <button
              type="button"
              onClick={() => void generate()}
              disabled={generating}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 14px",
                borderRadius: "var(--ta-r-sm, 9px)",
                fontSize: 12,
                fontWeight: 500,
                cursor: generating ? "not-allowed" : "pointer",
                border: "1px solid var(--ta-border-2)",
                background: "transparent",
                color: generating ? "var(--ta-text-mute)" : "var(--ta-text-soft)",
              }}
            >
              <RefreshCw size={12} />
              Regenerate
            </button>
          </div>
        </div>
      )}

      {/* spin keyframe — must live as a style tag since Tailwind `animate-spin` only works on className */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
