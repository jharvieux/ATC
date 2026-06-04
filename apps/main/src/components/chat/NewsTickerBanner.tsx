"use client";

// §TN — Horizontal scrolling news ticker for the chat page.
// Fetches /api/travel-news on mount and re-fetches every 30 minutes.
// Renders nothing until data arrives, and nothing if there are no articles.

import { useEffect, useRef, useState } from "react";

interface NewsArticle {
  id: string;
  title: string;
  url: string;
  source_name: string | null;
}

const REFRESH_MS = 30 * 60 * 1000;

export function NewsTickerBanner(): JSX.Element | null {
  const [articles, setArticles] = useState<NewsArticle[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchArticles(): Promise<void> {
    try {
      const res = await fetch("/api/travel-news");
      if (!res.ok) return;
      const data = await res.json() as { articles: NewsArticle[] };
      setArticles(data.articles ?? []);
    } catch {
      // best-effort — don't surface errors for the ticker
    }
  }

  useEffect(() => {
    void fetchArticles();
    timerRef.current = setInterval(() => { void fetchArticles(); }, REFRESH_MS);
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
  }, []);

  if (articles.length === 0) return null;

  const items = articles.map((a) => (
    <span key={a.id} className="inline-flex items-center gap-1.5 px-4">
      <span className="text-muted-foreground">•</span>
      <a
        href={a.url}
        target="_blank"
        rel="noopener noreferrer"
        className="hover:underline underline-offset-2 whitespace-nowrap"
      >
        {a.source_name ? (
          <>
            <span className="font-semibold text-foreground">{a.source_name}:</span>{" "}
            <span>{a.title}</span>
          </>
        ) : (
          a.title
        )}
      </a>
    </span>
  ));

  return (
    <div
      className="w-full overflow-hidden bg-muted/60 border-b border-border text-[12px] text-muted-foreground"
      aria-label="Travel news"
      role="marquee"
    >
      <div className="flex animate-ticker whitespace-nowrap py-1.5">
        {items}
        {/* Duplicate so the loop is seamless */}
        {items}
      </div>
      <style>{`
        @keyframes ticker-scroll {
          0%   { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        .animate-ticker {
          animation: ticker-scroll 60s linear infinite;
        }
        .animate-ticker:hover {
          animation-play-state: paused;
        }
      `}</style>
    </div>
  );
}
