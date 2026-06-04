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
  /** URL slug — also the DB persona key once the chat refactor lands. */
  slug: string;
  /** Full display name. */
  name: string;
  /** Region/topic specialty shown under the name on the card. */
  specialty: string;
  /** Single-line tagline shown on the card and profile page. */
  tagline: string;
  /** Public-asset URL for the agent's photo. */
  image: string;
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    slug: "marcus-cole",
    name: "Marcus Cole",
    specialty: "Caribbean & Latin America",
    tagline: "The Caribbean isn't one place. Let me help you find your version of it.",
    image: "/agents/marcus-cole.png",
  },
  {
    slug: "marco-bellini",
    name: "Marco Bellini",
    specialty: "Mediterranean & European Rivers",
    tagline: "The best meal of your life is waiting in a port city.",
    image: "/agents/marco-bellini.jpg",
  },
  {
    slug: "priya-sharma",
    name: "Priya Sharma",
    specialty: "Luxury & Ultra-Premium Cruises",
    tagline: "Luxury is not a price point. It is a ratio of experience delivered to expectation set.",
    image: "/agents/priya-sharma.jpg",
  },
  {
    slug: "captain-dave",
    name: "Captain Dave Kowalski",
    specialty: "Alaska & Adventure Cruises",
    tagline: "Most people have never seen a glacier calve. I'm going to change that.",
    image: "/agents/captain-dave.jpg",
  },
  {
    slug: "maya-patel",
    name: "Maya Patel",
    specialty: "Accessible & Inclusive Travel",
    tagline: "Every traveler deserves to see the world. I will make sure you can.",
    image: "/agents/maya-patel.jpg",
  },
  {
    slug: "jenny-hartwell",
    name: "Jenny Hartwell",
    specialty: "Family Cruising",
    tagline: "The kids will be begging to go back. So will you.",
    image: "/agents/jenny-hartwell.png",
  },
] as const;
