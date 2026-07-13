"use client";

// §TN — Platform admin: travel news feed management.
// Manage RSS feed URLs, trigger manual refreshes, hide articles, and send
// articles to the platform RAG pipeline.

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Feed {
  id: string;
  name: string;
  url: string;
  is_active: boolean;
  last_fetched_at: string | null;
  created_at: string;
}

interface Article {
  id: string;
  title: string;
  url: string;
  source_name: string | null;
  published_at: string | null;
  relevance_score: number | null;
  is_hidden: boolean;
  rag_submitted_at: string | null;
}

const inputCls = "px-2 py-1.5 border border-border rounded text-[14px] w-full box-border";

interface DataState {
  feeds: Feed[];
  articles: Article[];
  hiddenArticles: Article[];
  feedError: string | null;
}

interface AddFeedFormState {
  newName: string;
  newUrl: string;
  adding: boolean;
  addError: string | null;
}

interface RefreshState {
  refreshing: boolean;
  refreshMsg: string | null;
}

export default function TravelNewsPage(): JSX.Element {
  // #1812 — the 12 useState hooks (feed/article data, add-feed form, manual
  // refresh) are grouped into 3 state objects by concern, one useState each,
  // matching the pattern established in #1791. `showHidden` stays a single
  // hook — it's a standalone UI toggle, not part of a cluster.
  const [data, setData] = useState<DataState>({ feeds: [], articles: [], hiddenArticles: [], feedError: null });
  const [showHidden, setShowHidden] = useState(false);
  const [addFeedForm, setAddFeedForm] = useState<AddFeedFormState>({
    newName: "", newUrl: "", adding: false, addError: null,
  });
  const [refreshState, setRefreshState] = useState<RefreshState>({ refreshing: false, refreshMsg: null });

  const loadData = useCallback(async () => {
    const [feedsRes, articlesRes] = await Promise.all([
      fetch("/api/admin/travel-news/feeds"),
      fetch("/api/admin/travel-news/articles"),
    ]);
    if (feedsRes.ok) {
      const { feeds: f } = await feedsRes.json() as { feeds: Feed[] };
      setData((d) => ({ ...d, feeds: f }));
    }
    if (articlesRes.ok) {
      const { visible, hidden } = await articlesRes.json() as { visible: Article[]; hidden: Article[] };
      setData((d) => ({ ...d, articles: visible, hiddenArticles: hidden }));
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  async function addFeed(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setAddFeedForm((f) => ({ ...f, adding: true, addError: null }));
    const res = await fetch("/api/admin/travel-news/feeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: addFeedForm.newName.trim(), url: addFeedForm.newUrl.trim() }),
    });
    if (res.ok) {
      setAddFeedForm((f) => ({ ...f, newName: "", newUrl: "" }));
      await loadData();
    } else {
      const body = await res.json() as { error?: string };
      setAddFeedForm((f) => ({ ...f, addError: body.error ?? "Failed to add feed" }));
    }
    setAddFeedForm((f) => ({ ...f, adding: false }));
  }

  async function deleteFeed(id: string): Promise<void> {
    const res = await fetch(`/api/admin/travel-news/feeds/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      setData((d) => ({ ...d, feedError: body.error ?? "Failed to delete feed" }));
      return;
    }
    setData((d) => ({ ...d, feedError: null }));
    await loadData();
  }

  async function toggleActive(feed: Feed): Promise<void> {
    const res = await fetch(`/api/admin/travel-news/feeds/${feed.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: !feed.is_active }),
    });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      setData((d) => ({ ...d, feedError: body.error ?? "Failed to update feed" }));
      return;
    }
    setData((d) => ({ ...d, feedError: null }));
    await loadData();
  }

  async function triggerRefresh(): Promise<void> {
    setRefreshState({ refreshing: true, refreshMsg: null });
    const res = await fetch("/api/admin/travel-news/feeds/refresh", { method: "POST" });
    setRefreshState({
      refreshing: false,
      refreshMsg: res.ok ? "Refresh queued — check back in a minute." : "Failed to queue refresh.",
    });
  }

  async function hideArticle(id: string): Promise<void> {
    const res = await fetch(`/api/admin/travel-news/articles/${id}/hide`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      setData((d) => ({ ...d, feedError: body.error ?? "Failed to hide article" }));
      return;
    }
    setData((d) => ({ ...d, feedError: null }));
    await loadData();
  }

  async function sendToRag(id: string): Promise<void> {
    const res = await fetch(`/api/admin/travel-news/articles/${id}/rag`, { method: "POST" });
    if (!res.ok) {
      const body = await res.json() as { error?: string };
      setData((d) => ({ ...d, feedError: body.error ?? "Failed to send to RAG" }));
      return;
    }
    setData((d) => ({ ...d, feedError: null }));
    await loadData();
  }

  function fmt(iso: string | null): string {
    if (!iso) return "—";
    return new Date(iso).toLocaleString();
  }

  const { feeds, articles, hiddenArticles, feedError } = data;
  const { newName, newUrl, adding, addError } = addFeedForm;
  const { refreshing, refreshMsg } = refreshState;

  return (
    <main className="px-6 py-10 max-w-[900px] mx-auto">
      <h1 className="text-[26px] font-bold mb-1">Travel News Feeds</h1>
      <p className="text-muted-foreground text-[14px] mb-8">
        Manage RSS feeds, trigger refreshes, and curate articles for the chat page news ticker.
      </p>

      {feedError && (
        <p className="mb-4 text-[13px] text-red-600">{feedError}</p>
      )}

      {/* Feed management */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            Feeds
          </h2>
          <div className="flex items-center gap-2">
            {refreshMsg && (
              <span className="text-[13px] text-muted-foreground">{refreshMsg}</span>
            )}
            <Button variant="outline" onClick={() => void triggerRefresh()} disabled={refreshing}>
              {refreshing ? "Queuing…" : "Refresh Now"}
            </Button>
          </div>
        </div>

        <div className="border border-border rounded-lg overflow-hidden mb-4">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-muted border-b border-border">
                <th className="text-left px-3 py-2.5 font-semibold">Name</th>
                <th className="text-left px-3 py-2.5 font-semibold">URL</th>
                <th className="text-left px-3 py-2.5 font-semibold">Active</th>
                <th className="text-left px-3 py-2.5 font-semibold">Last fetched</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {feeds.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">No feeds yet.</td>
                </tr>
              )}
              {feeds.map((feed) => (
                <tr key={feed.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2.5 font-medium">{feed.name}</td>
                  <td className="px-3 py-2.5 max-w-[260px] truncate">
                    <a href={feed.url} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
                      {feed.url}
                    </a>
                  </td>
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => void toggleActive(feed)}
                      className={`text-[12px] px-2 py-0.5 rounded font-medium ${feed.is_active ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300" : "bg-muted text-muted-foreground"}`}
                    >
                      {feed.is_active ? "Active" : "Paused"}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{fmt(feed.last_fetched_at)}</td>
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => void deleteFeed(feed.id)}
                      className="text-[12px] text-red-600 hover:underline"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Add feed form */}
        <form onSubmit={(e) => void addFeed(e)} className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="block text-[12px] font-semibold mb-1 text-muted-foreground">Name</label>
            <Input
              className={inputCls}
              value={newName}
              onChange={(e) => setAddFeedForm((f) => ({ ...f, newName: e.target.value }))}
              placeholder="Travel Weekly"
              required
            />
          </div>
          <div className="flex-[2]">
            <label className="block text-[12px] font-semibold mb-1 text-muted-foreground">RSS URL</label>
            <Input
              className={inputCls}
              value={newUrl}
              onChange={(e) => setAddFeedForm((f) => ({ ...f, newUrl: e.target.value }))}
              placeholder="https://example.com/rss"
              type="url"
              required
            />
          </div>
          <Button type="submit" disabled={adding} className="shrink-0">
            {adding ? "Adding…" : "Add Feed"}
          </Button>
        </form>
        {addError && <p className="text-[13px] text-red-600 mt-1">{addError}</p>}
      </section>

      {/* Visible articles */}
      <section className="mb-10">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.05em] text-muted-foreground mb-3">
          Articles ({articles.length})
        </h2>
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="bg-muted border-b border-border">
                <th className="text-left px-3 py-2.5 font-semibold">Title</th>
                <th className="text-left px-3 py-2.5 font-semibold">Source</th>
                <th className="text-left px-3 py-2.5 font-semibold">Score</th>
                <th className="text-left px-3 py-2.5 font-semibold">Published</th>
                <th className="px-3 py-2.5 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {articles.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">
                    No articles yet — trigger a refresh or wait for the next scheduled run.
                  </td>
                </tr>
              )}
              {articles.map((article) => (
                <tr key={article.id} className="border-b border-border last:border-0">
                  <td className="px-3 py-2.5 max-w-[280px]">
                    <a href={article.url} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2 line-clamp-2">
                      {article.title}
                    </a>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">{article.source_name ?? "—"}</td>
                  <td className="px-3 py-2.5">
                    <span className={`font-mono ${(article.relevance_score ?? 0) >= 80 ? "text-green-600" : "text-foreground"}`}>
                      {article.relevance_score ?? "—"}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">{fmt(article.published_at)}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => void sendToRag(article.id)}
                        disabled={!!article.rag_submitted_at}
                        className={`text-[12px] px-2 py-0.5 rounded font-medium ${
                          article.rag_submitted_at
                            ? "bg-muted text-muted-foreground cursor-not-allowed"
                            : "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 hover:bg-blue-200"
                        }`}
                        title={article.rag_submitted_at ? `Submitted ${fmt(article.rag_submitted_at)}` : "Send to RAG pipeline"}
                      >
                        {article.rag_submitted_at ? "Submitted" : "Send to RAG"}
                      </button>
                      <button
                        onClick={() => void hideArticle(article.id)}
                        className="text-[12px] text-muted-foreground hover:text-red-600 hover:underline"
                      >
                        Hide
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Hidden articles (collapsible) */}
      <section>
        <button
          onClick={() => setShowHidden((v) => !v)}
          className="flex items-center gap-1.5 text-[13px] font-semibold uppercase tracking-[0.05em] text-muted-foreground mb-3"
        >
          <span>{showHidden ? "▾" : "▸"}</span>
          Hidden Articles ({hiddenArticles.length})
        </button>
        {showHidden && (
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="bg-muted border-b border-border">
                  <th className="text-left px-3 py-2.5 font-semibold">Title</th>
                  <th className="text-left px-3 py-2.5 font-semibold">Source</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {hiddenArticles.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-center text-muted-foreground">No hidden articles.</td>
                  </tr>
                )}
                {hiddenArticles.map((article) => (
                  <tr key={article.id} className="border-b border-border last:border-0">
                    <td className="px-3 py-2.5 max-w-[360px] line-clamp-1">{article.title}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{article.source_name ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right">
                      <button
                        onClick={async () => {
                          const res = await fetch(`/api/admin/travel-news/articles/${article.id}/hide`, {
                            method: "PATCH",
                          });
                          if (!res.ok) {
                            const body = await res.json() as { error?: string };
                            setData((d) => ({ ...d, feedError: body.error ?? "Failed to unhide article" }));
                            return;
                          }
                          setData((d) => ({ ...d, feedError: null }));
                          await loadData();
                        }}
                        className="text-[12px] text-primary hover:underline"
                      >
                        Unhide
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
