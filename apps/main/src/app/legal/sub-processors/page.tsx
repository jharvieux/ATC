// §25.5 — Sub-processors disclosure.
//
// Public static page (no auth) listing every vendor that processes
// customer data on the platform's behalf, with the data category.
// Reviewed annually by the subprocessors-annual-review Inngest cron.

const SUBPROCESSORS = [
  {
    vendor: "Anthropic",
    category: "AI inference (Claude — chat responses, content extraction, hate-speech heuristic)",
    region: "United States",
  },
  {
    vendor: "OpenAI",
    category: "AI image generation (DALL-E — group hero images, optional)",
    region: "United States",
  },
  {
    vendor: "Supabase",
    category: "Database, authentication, file storage (RAG submissions), pgvector",
    region: "United States",
  },
  {
    vendor: "Vercel",
    category: "Application hosting and edge compute",
    region: "United States",
  },
  {
    vendor: "Stripe",
    category: "Payment processing (subscriptions, Connect for commission payouts)",
    region: "United States",
  },
  {
    vendor: "Resend",
    category: "Transactional and marketing email delivery",
    region: "United States",
  },
  {
    vendor: "Inngest",
    category: "Background job orchestration (webhooks, retries, scheduled tasks)",
    region: "United States",
  },
  {
    vendor: "Sentry",
    category: "Error tracking (PII scrubbed via beforeSend hook)",
    region: "United States",
  },
] as const;

export default function SubProcessorsPage(): JSX.Element {
  return (
    <main className="px-6 py-8 max-w-[880px] mx-auto leading-[1.5]">
      <h1>Sub-processors</h1>
      <p>
        We engage the following sub-processors to deliver platform services.
        Each one is contractually bound to process customer data only as
        directed by AI Travel Concierge and only for the purpose listed.
      </p>
      <p className="text-muted-foreground text-[14px]">
        This list is reviewed annually (January 1) and updated whenever a new
        vendor is onboarded. See <a href="/legal/privacy" className="text-primary hover:underline">Privacy policy</a> for
        the full data handling commitments.
      </p>

      <div className="overflow-x-auto mt-4">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-muted">
              <th className="text-left px-2.5 py-2.5 border-b border-border font-semibold">Vendor</th>
              <th className="text-left px-2.5 py-2.5 border-b border-border font-semibold">Category</th>
              <th className="text-left px-2.5 py-2.5 border-b border-border font-semibold">Region</th>
            </tr>
          </thead>
          <tbody>
            {SUBPROCESSORS.map((s) => (
              <tr key={s.vendor}>
                <td className="px-2.5 py-2.5 border-b border-muted font-semibold">{s.vendor}</td>
                <td className="px-2.5 py-2.5 border-b border-muted">{s.category}</td>
                <td className="px-2.5 py-2.5 border-b border-muted">{s.region}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-8 text-muted-foreground text-[13px]">
        Last reviewed: TODO(operator) — bump after each annual review.
      </p>
    </main>
  );
}
