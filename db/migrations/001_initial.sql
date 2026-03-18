-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reporter',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  config JSONB DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);

-- Documents (migrated from SQLite, now with UUID project_id)
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  one_sentence_summary TEXT NOT NULL DEFAULT '',
  paragraph_summary TEXT NOT NULL DEFAULT '',
  date_range_earliest TEXT,
  date_range_latest TEXT,
  category TEXT NOT NULL DEFAULT 'other',
  content_tags JSONB NOT NULL DEFAULT '[]',
  full_text TEXT,
  analysis_timestamp TEXT NOT NULL DEFAULT NOW()::TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cost_usd REAL,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, doc_id)
);
CREATE INDEX IF NOT EXISTS idx_documents_project_id ON documents(project_id);
CREATE INDEX IF NOT EXISTS idx_documents_doc_id ON documents(doc_id);

-- RDF Triples
CREATE TABLE IF NOT EXISTS rdf_triples (
  id SERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL,
  timestamp TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  location TEXT,
  actor_likely_type TEXT,
  triple_tags JSONB,
  explicit_topic TEXT,
  implicit_topic TEXT,
  sequence_order INTEGER NOT NULL DEFAULT 0,
  top_cluster_ids JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rdf_triples_project_id ON rdf_triples(project_id);
CREATE INDEX IF NOT EXISTS idx_rdf_triples_actor ON rdf_triples(actor);
CREATE INDEX IF NOT EXISTS idx_rdf_triples_doc_id ON rdf_triples(doc_id);

-- Entity Aliases
CREATE TABLE IF NOT EXISTS entity_aliases (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  reasoning TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by TEXT DEFAULT 'llm_dedupe',
  PRIMARY KEY (project_id, original_name)
);

-- Canonical Entities (hop distances)
CREATE TABLE IF NOT EXISTS canonical_entities (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  canonical_name TEXT NOT NULL,
  hop_distance_from_principal INTEGER,
  PRIMARY KEY (project_id, canonical_name)
);

-- Tag clusters (per project)
CREATE TABLE IF NOT EXISTS tag_clusters (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  cluster_data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (project_id)
);

-- Project metadata (replaces docnet_metadata)
CREATE TABLE IF NOT EXISTS project_metadata (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (project_id, key)
);
