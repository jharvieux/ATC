-- §TN — Travel news feeds + articles.
-- Platform-level tables; no tenant_id. Only service_role touches these rows.
-- The Inngest cron populates articles; the admin console manages feeds.
--
-- Idempotent: uses IF NOT EXISTS / ON CONFLICT guards so this migration is
-- safe to apply against a DB where the tables were already created directly.

CREATE TABLE IF NOT EXISTS news_feeds (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  url             TEXT        NOT NULL UNIQUE,
  name            TEXT        NOT NULL,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  last_fetched_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE news_feeds ENABLE ROW LEVEL SECURITY;
-- No row-level access for any authenticated role; service_role bypasses RLS.
DROP POLICY IF EXISTS "no_access" ON news_feeds;
CREATE POLICY "no_access" ON news_feeds USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON news_feeds TO service_role;

CREATE TABLE IF NOT EXISTS news_articles (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id          UUID        NOT NULL REFERENCES news_feeds(id) ON DELETE CASCADE,
  title            TEXT        NOT NULL,
  url              TEXT        NOT NULL,
  description      TEXT,
  published_at     TIMESTAMPTZ,
  source_name      TEXT,
  relevance_score  INTEGER,            -- 0–100 from LLM; ≥60 shown in ticker
  is_hidden        BOOLEAN     NOT NULL DEFAULT false,
  rag_submitted_at TIMESTAMPTZ,        -- non-null = already sent to the RAG pipeline
  guid             TEXT        NOT NULL, -- RSS guid for deduplication
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (feed_id, guid)
);

ALTER TABLE news_articles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "no_access" ON news_articles;
CREATE POLICY "no_access" ON news_articles USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON news_articles TO service_role;

-- Ticker query: is_hidden=false AND relevance_score>=60, ordered by published_at DESC
CREATE INDEX IF NOT EXISTS news_articles_ticker_idx ON news_articles (is_hidden, relevance_score, published_at DESC)
  WHERE is_hidden = false;

-- Purge cron: delete by created_at
CREATE INDEX IF NOT EXISTS news_articles_created_at_idx ON news_articles (created_at);

-- Seed default travel RSS feeds (ON CONFLICT so reruns are safe).
INSERT INTO news_feeds (name, url) VALUES
  ('Travel Weekly',         'https://www.travelweekly.com/rss'),
  ('Cruise Critic News',    'https://www.cruisecritic.com/news/news.cfm?type=rss'),
  ('The Points Guy Cruises','https://thepointsguy.com/cruises/feed/'),
  ('Condé Nast Traveler',   'https://www.cntraveler.com/feed/rss'),
  ('Travel + Leisure',      'https://www.travelandleisure.com/rss/all.xml')
ON CONFLICT (url) DO NOTHING;
