// The failure this guards against is specific: schema.org Offer prices that
// contradict the visible pricing table are treated as structured-data spam,
// and the penalty is losing the rich result entirely.

import { beforeEach, afterEach, describe, expect, it } from "vitest";

import { PUBLIC_TIERS, annualSavingsUsd, tierByName } from "@/lib/pricing/public-tiers";
import {
  faqJsonLd,
  organizationJsonLd,
  softwareApplicationJsonLd,
} from "@/lib/seo/structured-data";

const original = process.env.PLATFORM_PRIMARY_DOMAIN;

beforeEach(() => {
  process.env.PLATFORM_PRIMARY_DOMAIN = "ai-travelconcierge.com";
});

afterEach(() => {
  if (original === undefined) delete process.env.PLATFORM_PRIMARY_DOMAIN;
  else process.env.PLATFORM_PRIMARY_DOMAIN = original;
});

describe("SoftwareApplication offers", () => {
  it("prices every tier from the same constant the pricing table renders", () => {
    const offers = softwareApplicationJsonLd().offers as Array<{
      name: string;
      price: string;
      priceCurrency: string;
    }>;

    expect(offers).toHaveLength(PUBLIC_TIERS.length);
    for (const tier of PUBLIC_TIERS) {
      const offer = offers.find((o) => o.name === tier.name);
      expect(offer?.price).toBe(tier.monthlyUsd.toFixed(2));
      expect(offer?.priceCurrency).toBe("USD");
    }
  });

  it("marks the price as recurring monthly, not a one-time charge", () => {
    const offers = softwareApplicationJsonLd().offers as Array<{
      priceSpecification: { referenceQuantity: { unitCode: string; value: number } };
    }>;

    for (const offer of offers) {
      expect(offer.priceSpecification.referenceQuantity.unitCode).toBe("MON");
      expect(offer.priceSpecification.referenceQuantity.value).toBe(1);
    }
  });

  it("claims no rating we have not collected", () => {
    // Inventing aggregateRating is a manual-action risk, not just dishonest.
    const json = JSON.stringify(softwareApplicationJsonLd());
    expect(json).not.toContain("aggregateRating");
    expect(json).not.toContain("Review");
  });
});

describe("annual pricing", () => {
  it("derives the advertised yearly saving from the two real prices", () => {
    // The page previously hardcoded "save $38"/"$118"/"$198" next to prices
    // that were also hardcoded, so a price change would have left the saving
    // silently wrong.
    expect(annualSavingsUsd(tierByName("Research"))).toBe(38);
    expect(annualSavingsUsd(tierByName("Professional"))).toBe(118);
    expect(annualSavingsUsd(tierByName("Agency"))).toBe(198);
  });
});

describe("FAQ graph", () => {
  it("maps each question to its answer", () => {
    const graph = faqJsonLd([{ q: "Does it cost money?", a: "Yes." }]);
    const entities = graph.mainEntity as Array<{
      name: string;
      acceptedAnswer: { text: string };
    }>;

    expect(entities).toHaveLength(1);
    expect(entities[0]?.name).toBe("Does it cost money?");
    expect(entities[0]?.acceptedAnswer.text).toBe("Yes.");
  });
});

describe("Organization graph", () => {
  it("anchors to the platform origin so page graphs can reference it by id", () => {
    const org = organizationJsonLd();
    expect(org["@id"]).toBe("https://ai-travelconcierge.com/#organization");
    expect(org.url).toBe("https://ai-travelconcierge.com");
  });
});
