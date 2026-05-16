import Link from "next/link";

const agents = [
  {
    id: "marcus-cole",
    name: "Marcus Cole",
    specialty: "Luxury Travel",
    tagline: "Crafting unforgettable luxury experiences worldwide.",
  },
  {
    id: "marco-bellini",
    name: "Marco Bellini",
    specialty: "European Escapes",
    tagline: "Your insider guide to the best of Europe.",
  },
  {
    id: "priya-sharma",
    name: "Priya Sharma",
    specialty: "Adventure & Wellness",
    tagline: "Balancing thrills with tranquility on every journey.",
  },
  {
    id: "captain-dave-kowalski",
    name: "Captain Dave Kowalski",
    specialty: "Cruise & Maritime",
    tagline: "Navigating the world's finest waterways for you.",
  },
  {
    id: "maya-patel",
    name: "Maya Patel",
    specialty: "Family Vacations",
    tagline: "Making memories that the whole family will treasure.",
  },
  {
    id: "jenny-hartwell",
    name: "Jenny Hartwell",
    specialty: "Honeymoons & Romance",
    tagline: "Setting the perfect scene for your love story.",
  },
];

function initials(name: string) {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("");
}

export default function Home() {
  return (
    <div className="min-h-screen bg-white">
      {/* Navigation */}
      <nav className="border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <span className="text-xl font-semibold text-gray-900">
          AI Travel Concierge
        </span>
        <div className="flex items-center gap-6">
          <Link
            href="/agents"
            className="text-gray-600 hover:text-gray-900 text-sm"
          >
            Meet Our Agents
          </Link>
          <Link
            href="/quiz"
            className="text-gray-600 hover:text-gray-900 text-sm"
          >
            Find My Agent
          </Link>
          <Link
            href="/sign-in"
            className="bg-gray-900 text-white text-sm px-4 py-2 rounded-md hover:bg-gray-700"
          >
            Sign In
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="text-center py-16 px-6">
        <h1 className="text-4xl font-bold text-gray-900">
          Meet Your AI Travel Agents
        </h1>
        <p className="mt-4 text-gray-500 max-w-xl mx-auto">
          Expert travel advisors powered by AI — each with a unique specialty,
          always ready to help.
        </p>
      </section>

      {/* Agent Grid */}
      <section className="px-6 pb-16 max-w-5xl mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {agents.map((agent) => (
            <div
              key={agent.id}
              className="border border-gray-200 rounded-xl p-6 flex flex-col items-center text-center"
            >
              <div className="w-16 h-16 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-semibold text-lg mb-4">
                {initials(agent.name)}
              </div>
              <h2 className="text-base font-semibold text-gray-900">
                {agent.name}
              </h2>
              <span className="mt-1 inline-block bg-indigo-50 text-indigo-700 text-xs font-medium px-2.5 py-0.5 rounded-full">
                {agent.specialty}
              </span>
              <p className="mt-2 text-sm text-gray-500">{agent.tagline}</p>
              <div className="mt-4 flex gap-3">
                <Link
                  href={`/chat/${agent.id}`}
                  className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-md hover:bg-indigo-700"
                >
                  Chat Now
                </Link>
                <Link
                  href={`/agents/${agent.id}`}
                  className="border border-gray-300 text-gray-700 text-sm px-4 py-2 rounded-md hover:bg-gray-50"
                >
                  Full Profile
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Quiz Promo */}
      <section className="bg-indigo-50 py-12 px-6 text-center">
        <p className="text-gray-700 text-base">
          Not sure which agent is right for you? Take our 2-minute quiz.
        </p>
        <Link
          href="/quiz"
          className="mt-4 inline-block bg-indigo-600 text-white text-sm px-6 py-3 rounded-md hover:bg-indigo-700"
        >
          Find My Agent
        </Link>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 py-6 text-center text-sm text-gray-400">
        &copy; {new Date().getFullYear()} AI Travel Concierge. All rights
        reserved.
      </footer>
    </div>
  );
}
