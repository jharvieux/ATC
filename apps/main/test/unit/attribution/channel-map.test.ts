// BP35 §35.5 — channel normalization tests.

import { describe, expect, it } from "vitest";
import { channelFromUtmMedium, channelFromManualCategory } from "@/lib/attribution/channel-map";

describe("channelFromUtmMedium", () => {
  it("social variants", () => {
    expect(channelFromUtmMedium("social")).toBe("social");
    expect(channelFromUtmMedium("sm")).toBe("social");
    expect(channelFromUtmMedium("social_media")).toBe("social");
    expect(channelFromUtmMedium("SOCIAL")).toBe("social");
  });
  it("search variants", () => {
    expect(channelFromUtmMedium("cpc")).toBe("search");
    expect(channelFromUtmMedium("ppc")).toBe("search");
    expect(channelFromUtmMedium("paid_search")).toBe("search");
    expect(channelFromUtmMedium("search")).toBe("search");
  });
  it("email variants", () => {
    expect(channelFromUtmMedium("email")).toBe("email");
    expect(channelFromUtmMedium("e-mail")).toBe("email");
    expect(channelFromUtmMedium("newsletter")).toBe("email");
  });
  it("referral variants", () => {
    expect(channelFromUtmMedium("referral")).toBe("referral");
    expect(channelFromUtmMedium("partner")).toBe("referral");
    expect(channelFromUtmMedium("affiliate")).toBe("referral");
  });
  it("null/empty → direct", () => {
    expect(channelFromUtmMedium(null)).toBe("direct");
    expect(channelFromUtmMedium("")).toBe("direct");
    expect(channelFromUtmMedium("   ")).toBe("direct");
  });
  it("anything else → other", () => {
    expect(channelFromUtmMedium("podcast")).toBe("other");
    expect(channelFromUtmMedium("billboard")).toBe("other");
  });
});

describe("channelFromManualCategory", () => {
  it("always offline", () => {
    expect(channelFromManualCategory("phone_referral")).toBe("offline");
    expect(channelFromManualCategory(null)).toBe("offline");
    expect(channelFromManualCategory("trade_show")).toBe("offline");
  });
});
