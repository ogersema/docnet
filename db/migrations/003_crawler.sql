CREATE TABLE IF NOT EXISTS web_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  crawled_at TIMESTAMPTZ DEFAULT NOW(),
  doc_count INTEGER DEFAULT 0,
  UNIQUE(project_id, url)
);
