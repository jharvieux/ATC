// §24.2 — Persistent (non-dismissible) AI disclosure banner.
// Text from platform_settings.chat_ai_disclosure_text; falls back to spec
// default if absent.

export function AIDisclosureBanner({ text }: { text?: string }): JSX.Element {
  const body = text ?? "AI-assisted chat — your conversations are reviewed for quality";
  return (
    <div
      role="note"
      aria-label="AI disclosure"
      className="sticky top-0 z-[5] bg-amber-50 dark:bg-amber-950 border-b border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-[13px] py-2 px-4 text-center"
    >
      {body}
    </div>
  );
}
