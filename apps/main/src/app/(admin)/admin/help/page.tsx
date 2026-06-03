"use client";

// BP31 §32.2.2 / §32.3 — Help section default view for tenant admins.
//
// Layout: left sidebar with section nav, right pane with rendered doc.
// Header bar has search + 3 buttons (Help / Bug / Feature) that open
// the HelpAIPanel slide-over.

import { useEffect, useState } from "react";
import { HelpAIPanel } from "@/components/help-ai/HelpAIPanel";

interface DocListItem {
  slug: string;
  title: string;
  order: number;
  category: string;
}

interface DocBody {
  slug: string;
  title: string;
  html: string;
}

interface SearchHit {
  slug: string;
  title: string;
  snippet: string;
}

type PanelFlow = "help" | "bug" | "feature";

// §17.x — session is in HttpOnly cookies that ride along same-origin fetches;
// no Bearer to attach. Helper kept so call sites don't churn.
async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(path, { ...init, headers });
}

export default function HelpPage(): JSX.Element {
  const [sections, setSections] = useState<DocListItem[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocBody | null>(null);
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [panelFlow, setPanelFlow] = useState<PanelFlow | null>(null);

  useEffect(() => {
    (async () => {
      const res = await authFetch("/api/help/docs");
      if (!res.ok) return;
      const body = (await res.json()) as { items: DocListItem[] };
      setSections(body.items);
      if (body.items[0]) setActiveSlug(body.items[0].slug);
    })();
  }, []);

  useEffect(() => {
    if (!activeSlug) return;
    (async () => {
      const res = await authFetch(`/api/help/docs/${activeSlug}`);
      if (!res.ok) return;
      setDoc((await res.json()) as DocBody);
    })();
  }, [activeSlug]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setSearchHits([]);
      return;
    }
    const t = setTimeout(async () => {
      const res = await authFetch(`/api/help/docs/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) return;
      const body = (await res.json()) as { items: SearchHit[] };
      setSearchHits(body.items);
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <div className="flex h-screen">
      <aside className="w-[280px] border-r border-border p-4 overflow-y-auto">
        <h2 className="text-[14px] font-semibold text-muted-foreground mb-2">Help docs</h2>
        <nav>
          {sections.map((s) => (
            <button
              key={s.slug}
              onClick={() => setActiveSlug(s.slug)}
              className={`block w-full px-3 py-2 text-left border-none rounded-md cursor-pointer mb-0.5 text-sm ${
                s.slug === activeSlug
                  ? "bg-indigo-50 dark:bg-indigo-950/30 text-primary font-medium"
                  : "bg-transparent text-foreground hover:bg-muted"
              }`}
            >
              {s.title}
            </button>
          ))}
        </nav>
        <hr className="my-4 border-border" />
        <a href="/admin/help/print" className="text-[13px] text-muted-foreground">Print / download view →</a>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <header className="border-b border-border px-6 py-4 flex gap-4 items-center">
          <input
            type="search"
            placeholder="Search docs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 px-3 py-2 border border-border rounded-md text-sm"
          />
          <button
            onClick={() => setPanelFlow("help")}
            className="px-3 py-2 bg-primary text-primary-foreground border-none rounded-md cursor-pointer text-[13px] whitespace-nowrap"
          >
            I need help
          </button>
          <button
            onClick={() => setPanelFlow("bug")}
            className="px-3 py-2 bg-primary text-primary-foreground border-none rounded-md cursor-pointer text-[13px] whitespace-nowrap"
          >
            Report a bug
          </button>
          <button
            onClick={() => setPanelFlow("feature")}
            className="px-3 py-2 bg-primary text-primary-foreground border-none rounded-md cursor-pointer text-[13px] whitespace-nowrap"
          >
            Request a feature
          </button>
        </header>

        <div className="px-6 py-6 max-w-[800px]">
          {searchHits.length > 0 && (
            <section className="mb-8">
              <h3 className="text-[14px] text-muted-foreground mb-2">Search results</h3>
              <ul className="list-none p-0">
                {searchHits.map((h) => (
                  <li key={h.slug} className="mb-2">
                    <button
                      onClick={() => { setActiveSlug(h.slug); setQuery(""); }}
                      className="bg-transparent border-none p-0 text-primary cursor-pointer text-left"
                    >
                      <strong>{h.title}</strong>
                    </button>
                    <p className="text-[13px] text-muted-foreground mt-0.5 mb-0">{h.snippet}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {doc ? (
            <article dangerouslySetInnerHTML={{ __html: doc.html }} />
          ) : (
            <p className="text-muted-foreground">Select a section from the left.</p>
          )}
        </div>
      </main>

      {panelFlow && (
        <HelpAIPanel
          sessionType={panelFlow}
          sourceSurface="admin"
          onClose={() => setPanelFlow(null)}
        />
      )}
    </div>
  );
}
