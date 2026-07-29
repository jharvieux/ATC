// schema.org graphs for the indexable marketing surfaces.
//
// Answer engines (ChatGPT, Perplexity, Google AI Overviews) lean on this
// markup far more heavily than classic ranking does — it is the difference
// between "there is a page about cruise software" and "AI Travel Concierge
// costs $19-$99/mo, works with your existing host agency, and includes a
// 30-day trial", which is what actually gets cited in an answer.
//
// Every claim here must already be true on the rendered page. No
// aggregateRating and no review markup: we have no collected ratings, and
// inventing them is both dishonest and a manual-action risk.

import { PUBLIC_TIERS } from "@/lib/pricing/public-tiers";
import { siteOrigin } from "@/lib/seo/site";

const ORGANIZATION_ID = "#organization";

export function organizationJsonLd(): Record<string, unknown> {
  const origin = siteOrigin();
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${origin}/${ORGANIZATION_ID}`,
    name: "AI Travel Concierge",
    url: origin,
    logo: `${origin}/brand/logo-horizontal.svg`,
    description:
      "AI and software platform for independent cruise travel agents. Agents bring their own host agency and keep their commissions.",
  };
}

export function websiteJsonLd(): Record<string, unknown> {
  const origin = siteOrigin();
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${origin}/#website`,
    url: origin,
    name: "AI Travel Concierge",
    publisher: { "@id": `${origin}/${ORGANIZATION_ID}` },
    inLanguage: "en-US",
  };
}

/**
 * The product graph for the homepage — the page that sells the platform to
 * travel agents. Offers carry the same list prices the pricing table renders.
 */
export function softwareApplicationJsonLd(): Record<string, unknown> {
  const origin = siteOrigin();
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    "@id": `${origin}/#software`,
    name: "AI Travel Concierge",
    url: origin,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Travel agency software",
    operatingSystem: "Web browser",
    provider: { "@id": `${origin}/${ORGANIZATION_ID}` },
    description:
      "AI cruise-selling platform for independent travel agents. Six AI cruise specialists handle client chat, quoting, research, and follow-up, backed by a CRM that fills itself in. Agents connect their existing host agency and keep 100% of their commission.",
    featureList: [
      "Six AI cruise specialists covering Caribbean, Mediterranean, Alaska, luxury, family, and accessible travel",
      "Built-in CRM with automatic client memory and conversation logging",
      "Instant AI-generated quotes from host agency inventory",
      "Automated 90/7/1-day pre-cruise email sequences",
      "Knowledge base that answers from the agency's own materials",
      "Automated supervisor review of every AI reply before it sends",
      "White-label custom domain and email-from address on the Agency tier",
    ],
    offers: PUBLIC_TIERS.map((tier) => ({
      "@type": "Offer",
      name: tier.name,
      price: tier.monthlyUsd.toFixed(2),
      priceCurrency: "USD",
      category: "subscription",
      url: `${origin}/#pricing`,
      availability: "https://schema.org/InStock",
      // referenceQuantity is what makes this "$59 per one month" rather
      // than "$59 once" — without it a subscription price reads as a
      // one-time charge in rich results.
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: tier.monthlyUsd.toFixed(2),
        priceCurrency: "USD",
        referenceQuantity: {
          "@type": "QuantitativeValue",
          value: 1,
          unitCode: "MON",
        },
      },
    })),
  };
}

export interface FaqItem {
  q: string;
  a: string;
}

export function faqJsonLd(faqs: readonly FaqItem[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "@id": `${siteOrigin()}/#faq`,
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}
