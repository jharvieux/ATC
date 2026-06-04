-- §TN — Travel news feeds + articles.
-- Platform-level tables; no tenant_id. Only service_role touches these rows.
-- The Inngest cron populates articles; the admin console manages feeds.

CREATE TABLE news_feeds (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  url             TEXT        NOT NULL UNIQUE,
  name            TEXT        NOT NULL,
  is_active       BOOLEAN     NOT NULL DEFAULT true,
  last_fetched_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE news_feeds ENABLE ROW LEVEL SECURITY;
-- No row-level access for any authenticated role; service_role bypasses RLS.
CREATE POLICY "no_access" ON news_feeds USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON news_feeds TO service_role;

CREATE TABLE news_articles (
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
CREATE POLICY "no_access" ON news_articles USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON news_articles TO service_role;

-- Seed default travel RSS feeds.
INSERT INTO news_feeds (name, url) VALUES
  ('Travel Weekly',         'https://www.travelweekly.com/rss'),
  ('Cruise Critic News',    'https://www.cruisecritic.com/news/news.cfm?type=rss'),
  ('The Points Guy Cruises','https://thepointsguy.com/cruises/feed/'),
  ('Condé Nast Traveler',   'https://www.cntraveler.com/feed/rss'),
  ('Travel + Leisure',      'https://www.travelandleisure.com/rss/all.xml');
