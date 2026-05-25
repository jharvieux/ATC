// BP36 §36.9 — Reports dashboard landing page.
//
// Lists the 6 standard reports per §36.2. Each card links to its own page.
// Tier-gated server-side at each report API; this page itself shows the
// links regardless and lets the API return 403 with reason if applicable.

const REPORTS = [
  { slug: "leads-by-source", title: "Leads by source", description: "Acquired contacts by channel + campaign." },
  { slug: "bookings-by-source", title: "Bookings by source", description: "Confirmed bookings + commission by conversion-touch." },
  { slug: "source-funnel", title: "Source funnel", description: "Contact → quote → booking conversion %." },
  { slug: "campaigns", title: "Campaign performance", description: "Per-campaign leads, bookings, commission, cost-per-lead." },
  { slug: "first-vs-last-touch", title: "First-touch vs last-touch", description: "Multi-touch journey: which channel acquires vs which closes." },
  { slug: "cancellations", title: "Lost revenue from cancellations", description: "Cancelled bookings by reason + revenue impact." },
];

export default function ReportsLandingPage(): JSX.Element {
  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-semibold mb-2">Reports</h1>
      <p className="text-sm text-gray-500 mb-6">
        Insights from §35 attribution + §14 commissions data. MV-backed reports refresh nightly; live reports reflect current state.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {REPORTS.map((r) => (
          <a
            key={r.slug}
            href={`/crm/reports/${r.slug}`}
            className="block border border-gray-200 rounded-lg p-4 hover:border-blue-400 hover:bg-blue-50"
          >
            <div className="font-semibold text-blue-700">{r.title}</div>
            <div className="text-sm text-gray-600 mt-1">{r.description}</div>
          </a>
        ))}
      </div>
    </div>
  );
}
