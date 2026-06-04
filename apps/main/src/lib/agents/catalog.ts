// Source of truth for the 6 customer-facing agent personas surfaced on
// the marketing landing, the agent picker (Phase 5b), and the per-agent
// chat route (Phase 5c). Names + biographies + image filenames mirror
// the POC at https://ai-travel-concierge-tawny.vercel.app — the
// underlying persona records in the DB carry the same identities (user
// confirmed the 1:1 mapping).
//
// Photos live in /public/agents/{slug}.{ext} (scraped from the POC and
// bundled with the app). The `image` field stores the public URL path.

export interface AgentCatalogEntry {
  slug: string;
  name: string;
  specialty: string;
  tagline: string;
  image: string;
  /** Multi-paragraph biography shown on /agents/[slug]. Each entry in the
   *  array becomes a paragraph. Sourced from the POC marketing copy until
   *  a follow-up wires these to the DB personas' `background` column. */
  bio: string[];
  /** Quiz tags that, when matched against the user's answers, score this
   *  agent. The picker at /agents/quiz sums hits across answers and
   *  recommends the top-scoring agent. */
  quizTags: string[];
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    slug: "marcus-cole",
    name: "Marcus Cole",
    specialty: "Caribbean & Latin America",
    tagline: "The Caribbean isn't one place. Let me help you find your version of it.",
    image: "/agents/marcus-cole.png",
    bio: [
      "Marcus has spent fifteen years walking the docks of San Juan, Aruba, and Cozumel — every Caribbean port has a different rhythm, and he knows which ones reward divers, which ones reward foodies, and which ones reward people who just want to read on a beach.",
      "His specialty is matching the right island chain to your travel style. Eastern, Western, Southern, the ABC islands, the Bahamas — they sound interchangeable in a brochure and aren't.",
    ],
    quizTags: ["caribbean", "warm", "beach"],
  },
  {
    slug: "marco-bellini",
    name: "Marco Bellini",
    specialty: "Mediterranean & European Rivers",
    tagline: "The best meal of your life is waiting in a port city.",
    image: "/agents/marco-bellini.jpg",
    bio: [
      "Marco grew up between Venice and Bari, so the Mediterranean isn't a destination to him — it's the place he keeps coming back to. He covers the Western Med (Barcelona, Marseille, Cinque Terre), the Adriatic (Croatia, Montenegro, the Greek isles), and the European river circuits — the Rhine, the Danube, the Douro.",
      "If you care about food, ports of call, shore excursions that aren't tourist traps, and not paying twice for the same museum — he's your agent.",
    ],
    quizTags: ["mediterranean", "europe", "food", "history", "river"],
  },
  {
    slug: "priya-sharma",
    name: "Priya Sharma",
    specialty: "Luxury & Ultra-Premium Cruises",
    tagline: "Luxury is not a price point. It is a ratio of experience delivered to expectation set.",
    image: "/agents/priya-sharma.jpg",
    bio: [
      "Priya started in concierge at the Taj Mahal Palace and moved through every luxury line — Regent, Silversea, Seabourn, Explora — before specializing in advising travelers on which ultra-premium product actually fits their definition of luxury.",
      "Spoiler: it varies wildly. A 14-night world cruise on a 600-passenger ship is a completely different product than a 7-night yacht-style sailing in Asia.",
    ],
    quizTags: ["luxury", "premium", "small-ship", "world"],
  },
  {
    slug: "captain-dave",
    name: "Captain Dave Kowalski",
    specialty: "Alaska & Adventure Cruises",
    tagline: "Most people have never seen a glacier calve. I'm going to change that.",
    image: "/agents/captain-dave.jpg",
    bio: [
      "Captain Dave ran small expedition ships in southeast Alaska for twelve years. Glacier Bay, Tracy Arm, Endicott — he knows when to be there, which line gets you closest, and which lodge to add on for an inside passage finish.",
      "He's also the agent to ask about Antarctica, Iceland, and the Norwegian fjords. Cold-water cruising has its own rhythm and the wrong line in the wrong season ruins it.",
    ],
    quizTags: ["alaska", "adventure", "expedition", "cold", "wildlife"],
  },
  {
    slug: "maya-patel",
    name: "Maya Patel",
    specialty: "Accessible & Inclusive Travel",
    tagline: "Every traveler deserves to see the world. I will make sure you can.",
    image: "/agents/maya-patel.jpg",
    bio: [
      "Maya specializes in cruises for travelers with mobility, sensory, dietary, or medical considerations — and for the families and companions who travel with them.",
      "She knows which ships have which accessible cabin categories, which lines are realistic about ADA-style accommodations vs. which oversell, and which excursions actually work for travelers with limited mobility.",
    ],
    quizTags: ["accessible", "mobility", "inclusive", "family"],
  },
  {
    slug: "jenny-hartwell",
    name: "Jenny Hartwell",
    specialty: "Family Cruising",
    tagline: "The kids will be begging to go back. So will you.",
    image: "/agents/jenny-hartwell.png",
    bio: [
      "Jenny has cruised every major family-friendly line with kids of her own — Disney, Royal Caribbean, Norwegian, Carnival, MSC. She knows which ships are realistic for a 4-year-old, which work for tweens, and which lines have kids' clubs the kids actually want to go to.",
      "Multigenerational trips, kids-sail-free deals, picking the cabin so nobody has a meltdown — that's her thing.",
    ],
    quizTags: ["family", "kids", "multigen", "disney"],
  },
] as const;
