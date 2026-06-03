// BP31 §32.2.2 / §32.3.3 — Print-friendly concat view.
//
// Server-side render of every doc concatenated. The user invokes browser
// print (Cmd-P / Ctrl-P) — no server PDF generation needed for this path.

// Force dynamic — the docs loader reads from the filesystem at request
// time; prerendering at build time would resolve relative paths to the
// bundled output dir which doesn't contain the source markdown.
export const dynamic = "force-dynamic";

import { renderAllDocsConcatenated } from "@/lib/help-ai/markdown-render";

export default async function HelpPrintPage(): Promise<JSX.Element> {
  const html = await renderAllDocsConcatenated();
  return (
    <>
      <style>{`
        @media print {
          .print-hide { display: none !important; }
          body { font-size: 11pt; line-height: 1.4; }
          h1 { page-break-before: always; }
          h1:first-of-type { page-break-before: avoid; }
        }
        body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; color: #111827; }
        h1 { font-size: 1.75rem; margin-top: 2rem; }
        h2 { font-size: 1.25rem; margin-top: 1.5rem; }
        hr.help-doc-separator { margin: 2rem 0; border: none; border-top: 1px solid #e5e7eb; }
        a { color: #4f46e5; }
        pre, code { font-family: ui-monospace, monospace; background: #f3f4f6; padding: 0.1rem 0.3rem; border-radius: 3px; }
      `}</style>
      <header className="print-hide mb-4 text-muted-foreground text-[13px]">
        <p>This is the print-friendly view of the platform documentation.</p>
        <p>Use your browser&apos;s print command (Cmd-P / Ctrl-P) to print or save as PDF.</p>
      </header>
      <article dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}
