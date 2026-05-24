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

async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = typeof window !== "undefined" ? localStorage.getItem("sb-access-token") : null;
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body) headers.set("Content-Type", "application/json");
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
    <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <aside style={{ width: 280, borderRight: "1px solid #e5e7eb", padding: "1rem", overflowY: "auto" }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: "#6b7280", marginBottom: 8 }}>Help docs</h2>
        <nav>
          {sections.map((s) => (
            <button
              key={s.slug}
              onClick={() => setActiveSlug(s.slug)}
              style={{
                display: "block",
                width: "100%",
                padding: "0.5rem 0.75rem",
                textAlign: "left",
                background: s.slug === activeSlug ? "#eef2ff" : "transparent",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
                marginBottom: 2,
              }}
            >
              {s.title}
            </button>
          ))}
        </nav>
        <hr style={{ margin: "1rem 0", border: "none", borderTop: "1px solid #e5e7eb" }} />
        <a href="/admin/help/print" style={{ fontSize: 13, color: "#6b7280" }}>Print / download view →</a>
      </aside>

      <main style={{ flex: 1, overflowY: "auto" }}>
        <header style={{ borderBottom: "1px solid #e5e7eb", padding: "1rem 1.5rem", display: "flex", gap: "1rem", alignItems: "center" }}>
          <input
            type="search"
            placeholder="Search docs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, padding: "0.5rem 0.75rem", border: "1px solid #d1d5db", borderRadius: 6 }}
          />
          <button onClick={() => setPanelFlow("help")} style={btnStyle}>I need help</button>
          <button onClick={() => setPanelFlow("bug")} style={btnStyle}>Report a bug</button>
          <button onClick={() => setPanelFlow("feature")} style={btnStyle}>Request a feature</button>
        </header>

        <div style={{ padding: "1.5rem", maxWidth: 800 }}>
          {searchHits.length > 0 && (
            <section style={{ marginBottom: "2rem" }}>
              <h3 style={{ fontSize: 14, color: "#6b7280", marginBottom: 8 }}>Search results</h3>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {searchHits.map((h) => (
                  <li key={h.slug} style={{ marginBottom: 8 }}>
                    <button onClick={() => { setActiveSlug(h.slug); setQuery(""); }} style={{ background: "none", border: "none", padding: 0, color: "#4f46e5", cursor: "pointer", textAlign: "left" }}>
                      <strong>{h.title}</strong>
                    </button>
                    <p style={{ fontSize: 13, color: "#6b7280", margin: "2px 0 0" }}>{h.snippet}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {doc ? (
            <article dangerouslySetInnerHTML={{ __html: doc.html }} />
          ) : (
            <p style={{ color: "#6b7280" }}>Select a section from the left.</p>
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

const btnStyle: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  background: "#4f46e5",
  color: "white",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
  whiteSpace: "nowrap",
};
