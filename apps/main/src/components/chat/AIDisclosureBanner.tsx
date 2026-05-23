// §24.2 — Persistent (non-dismissible) AI disclosure banner.
// Text from platform_settings.chat_ai_disclosure_text; falls back to spec
// default if absent.

export function AIDisclosureBanner({ text }: { text?: string }): JSX.Element {
  const body = text ?? "AI-assisted chat — your conversations are reviewed for quality";
  return (
    <div
      role="note"
      aria-label="AI disclosure"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 5,
        background: "#fffbeb",
        borderBottom: "1px solid #fde68a",
        color: "#78350f",
        fontSize: 13,
        padding: "8px 16px",
        textAlign: "center",
      }}
    >
      {body}
    </div>
  );
}
