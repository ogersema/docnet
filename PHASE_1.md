# Phase 1 – Foundation
## PostgreSQL · Authentication · Projects

Read CLAUDE.md completely before starting. This is the foundational phase —
everything in Phases 2–4 depends on getting this right.

**Deliverable:** A running Express server with PostgreSQL, where a user can
register, log in, create projects, and see an empty graph page per project.
No upload yet. No analysis yet. Just the structural shell.

---

## Step 1.1 — Install Dependencies

```bash
npm install pg @types/pg bcrypt @types/bcrypt jsonwebtoken @types/jsonwebtoken uuid @types/uuid
npm install --save-dev @types/pg
```

Also install for frontend:
```bash
cd network-ui
npm install react-router-dom@6 @types/react-router-dom
```

---

## Step 1.2 — PostgreSQL Setup Script

Create `db/setup.sh` (run once on the server):

```bash
#!/bin/bash
# Run as root or with sudo
sudo -u postgres psql << 'EOF'
CREATE USER docnet WITH PASSWORD 'CHANGE_THIS_PASSWORD';
CREATE DATABASE docnet OWNER docnet;
GRANT ALL PRIVILEGES ON DATABASE docnet TO docnet;
\c docnet
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
EOF
echo "PostgreSQL setup complete."
```

Create `db/migrate.ts` — the migration runner:

```typescript
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  // Create migrations tracking table if not exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const version = file.replace('.sql', '');
    const { rows } = await pool.query(
      'SELECT version FROM schema_migrations WHERE version = $1', [version]
    );
    if (rows.length > 0) {
      console.log(`  Skipping ${version} (already applied)`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    console.log(`  Applied ${version}`);
  }

  await pool.end();
  console.log('Migrations complete.');
}

migrate().catch(err => { console.error(err); process.exit(1); });
```

---

## Step 1.3 — Database Migrations

Create `db/migrations/001_initial.sql`:

```sql
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
```

Create `db/migrations/002_jobs.sql`:

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payload JSONB NOT NULL DEFAULT '{}',
  progress INTEGER DEFAULT 0,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_jobs_project_id ON jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
```

Create `db/migrations/003_crawler.sql`:

```sql
CREATE TABLE IF NOT EXISTS web_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  crawled_at TIMESTAMPTZ DEFAULT NOW(),
  doc_count INTEGER DEFAULT 0,
  UNIQUE(project_id, url)
);
```

---

## Step 1.4 — Auth Utilities

Create `auth/passwords.ts`:

```typescript
import bcrypt from 'bcrypt';

const ROUNDS = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
```

Create `auth/tokens.ts`:

```typescript
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('JWT_SECRET environment variable is required');

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: '7d' });
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, SECRET) as TokenPayload;
}
```

Create `auth/middleware.ts`:

```typescript
import { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from './tokens';

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    req.user = verifyToken(header.slice(7));
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Use this for routes that can work with or without auth
export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try { req.user = verifyToken(header.slice(7)); } catch {}
  }
  next();
}
```

---

## Step 1.5 — PostgreSQL Adapter

Create `storage/PostgresAdapter.ts`. This implements `IStorageAdapter` using `pg`.

The adapter takes a `projectId: string` as constructor argument — every
method automatically filters by this project. The API routes create a new
adapter instance per request: `new PostgresAdapter(pool, req.params.projectId)`.

Key methods to implement (all filter by `this.projectId`):
- `getStats()` → counts of documents, triples, actors
- `getTagClusters()` → from `tag_clusters` table
- `getRelationships(params)` → from `rdf_triples` with filters
- `getActorRelationships(name, params)` → actor-specific view
- `searchActors(query)` → ILIKE search on actor names
- `getActorCount(name)` → total count for one actor
- `getActorCounts(limit)` → top N actors by triple count
- `getDocument(docId)` → from `documents`
- `getDocumentText(docId)` → `full_text` field
- `saveDocument(doc)` → INSERT into `documents`
- `saveTriples(triples)` → bulk INSERT into `rdf_triples`
- `saveAliases(aliases)` → INSERT into `entity_aliases`
- `getTagClusterData()` → raw JSON for worker use
- `saveTagClusterData(data)` → UPSERT into `tag_clusters`

Use `pool.query()` with `$1, $2, ...` parameterized queries throughout.
All queries must include `WHERE project_id = $N`.

---

## Step 1.6 — Auth Routes

Create `routes/auth.ts`:

```typescript
import { Router } from 'express';
import { pool } from '../db/pool';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { signToken } from '../auth/tokens';
import { authMiddleware } from '../auth/middleware';

const router = Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body;

  // Validation
  if (!email || !password || !displayName) {
    return res.status(400).json({ error: 'email, password, displayName required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    const hash = await hashPassword(password);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3) RETURNING id, email, display_name, role`,
      [email.toLowerCase(), hash, displayName]
    );
    const user = rows[0];

    // Create a default first project
    await pool.query(
      `INSERT INTO projects (user_id, name, description)
       VALUES ($1, $2, $3)`,
      [user.id, 'My first project', 'Default project created on registration']
    );

    const token = signToken({ userId: user.id, email: user.email, role: user.role });
    res.status(201).json({ token, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } });
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email address already registered' });
    }
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password required' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT id, email, password_hash, display_name, role FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = rows[0];
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken({ userId: user.id, email: user.email, role: user.role });
    res.json({ token, user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me  (verify current token)
router.get('/me', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, email, display_name, role FROM users WHERE id = $1',
    [req.user!.userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
  const u = rows[0];
  res.json({ id: u.id, email: u.email, displayName: u.display_name, role: u.role });
});

export default router;
```

---

## Step 1.7 — Projects Routes

Create `routes/projects.ts`:

```typescript
import { Router } from 'express';
import { pool } from '../db/pool';
import { authMiddleware } from '../auth/middleware';

const router = Router();

// Helper: verify project belongs to user
async function requireProjectOwner(projectId: string, userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, userId]
  );
  return rows.length > 0;
}

// GET /api/projects  — list user's projects
router.get('/', authMiddleware, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.description, p.status, p.created_at,
       (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id) as doc_count,
       (SELECT COUNT(*) FROM rdf_triples t WHERE t.project_id = p.id) as triple_count
     FROM projects p
     WHERE p.user_id = $1 AND p.status != 'deleted'
     ORDER BY p.updated_at DESC`,
    [req.user!.userId]
  );
  res.json(rows);
});

// POST /api/projects  — create project
router.post('/', authMiddleware, async (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Project name is required' });

  const { rows } = await pool.query(
    `INSERT INTO projects (user_id, name, description) VALUES ($1, $2, $3)
     RETURNING id, name, description, status, created_at`,
    [req.user!.userId, name.trim(), description?.trim() || '']
  );
  res.status(201).json(rows[0]);
});

// GET /api/projects/:id  — get one project
router.get('/:id', authMiddleware, async (req, res) => {
  const owned = await requireProjectOwner(req.params.id, req.user!.userId);
  if (!owned) return res.status(404).json({ error: 'Project not found' });

  const { rows } = await pool.query(
    `SELECT p.*,
       (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id) as doc_count,
       (SELECT COUNT(*) FROM rdf_triples t WHERE t.project_id = p.id) as triple_count,
       (SELECT COUNT(*) FROM jobs j WHERE j.project_id = p.id AND j.status = 'running') as running_jobs
     FROM projects p WHERE p.id = $1`,
    [req.params.id]
  );
  res.json(rows[0]);
});

// PATCH /api/projects/:id  — update name/description
router.patch('/:id', authMiddleware, async (req, res) => {
  const owned = await requireProjectOwner(req.params.id, req.user!.userId);
  if (!owned) return res.status(404).json({ error: 'Project not found' });

  const { name, description } = req.body;
  await pool.query(
    `UPDATE projects SET name = COALESCE($1, name), description = COALESCE($2, description), updated_at = NOW()
     WHERE id = $3`,
    [name?.trim(), description?.trim(), req.params.id]
  );
  res.json({ ok: true });
});

// DELETE /api/projects/:id  — soft delete
router.delete('/:id', authMiddleware, async (req, res) => {
  const owned = await requireProjectOwner(req.params.id, req.user!.userId);
  if (!owned) return res.status(404).json({ error: 'Project not found' });

  await pool.query(
    `UPDATE projects SET status = 'deleted', updated_at = NOW() WHERE id = $1`,
    [req.params.id]
  );
  res.json({ ok: true });
});

export { requireProjectOwner };
export default router;
```

---

## Step 1.8 — Database Connection Pool

Create `db/pool.ts`:

```typescript
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});
```

---

## Step 1.9 — Update api_server.ts

Refactor `api_server.ts` to:
1. Import `pool` from `db/pool.ts`
2. Mount auth router: `app.use('/api/auth', authRouter)`
3. Mount projects router: `app.use('/api/projects', projectsRouter)`
4. Wrap all existing graph endpoints with `authMiddleware`
5. Extract `project_id` from `req.params.projectId` (new URL structure:
   `/api/projects/:projectId/relationships`, etc.)
6. Instantiate `PostgresAdapter(pool, projectId)` per request instead
   of the global SQLite adapter

New graph endpoint structure:
```
GET /api/projects/:projectId/relationships
GET /api/projects/:projectId/actors
GET /api/projects/:projectId/actor/:name/relationships
GET /api/projects/:projectId/stats
GET /api/projects/:projectId/search
GET /api/projects/:projectId/tag-clusters
GET /api/projects/:projectId/document/:docId
GET /api/projects/:projectId/document/:docId/text
```

Move all existing route handlers from `api_server.ts` to `routes/graph.ts`.

---

## Step 1.10 — Frontend: Auth + Project Pages

### Auth context (`network-ui/src/hooks/useAuth.ts`)

```typescript
import { createContext, useContext, useState, useEffect } from 'react';

interface User { id: string; email: string; displayName: string; role: string; }
interface AuthContext {
  user: User | null;
  token: string | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  isLoading: boolean;
}

const AuthCtx = createContext<AuthContext>(null!);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem('docnet_token');
    if (stored) {
      // Verify token is still valid
      fetch('/api/auth/me', { headers: { Authorization: `Bearer ${stored}` } })
        .then(r => r.ok ? r.json() : null)
        .then(u => { if (u) { setToken(stored); setUser(u); } else { localStorage.removeItem('docnet_token'); } })
        .finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, []);

  const login = (t: string, u: User) => {
    localStorage.setItem('docnet_token', t);
    setToken(t); setUser(u);
  };
  const logout = () => {
    localStorage.removeItem('docnet_token');
    setToken(null); setUser(null);
  };

  return <AuthCtx.Provider value={{ user, token, login, logout, isLoading }}>{children}</AuthCtx.Provider>;
}
```

### Pages to create

`network-ui/src/pages/Login.tsx` — email + password form, calls `/api/auth/login`,
stores token, redirects to `/projects`.

`network-ui/src/pages/Register.tsx` — same structure, calls `/api/auth/register`.

`network-ui/src/pages/ProjectList.tsx` — lists all user's projects from
`GET /api/projects`. Each project shows name, doc count, triple count, and
a "Open" button. Plus a "New Project" button that opens an inline form.

`network-ui/src/pages/ProjectDetail.tsx` — the main app page for one project.
Contains the existing graph UI (moved from `App.tsx`) but now all API calls
use `/api/projects/:projectId/*` URLs. Also shows an upload section (Phase 2).

### Router (`network-ui/src/main.tsx`)

```tsx
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

<BrowserRouter>
  <AuthProvider>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/projects" element={<ProtectedRoute><ProjectList /></ProtectedRoute>} />
      <Route path="/projects/:id" element={<ProtectedRoute><ProjectDetail /></ProtectedRoute>} />
      <Route path="/" element={<Navigate to="/projects" replace />} />
    </Routes>
  </AuthProvider>
</BrowserRouter>
```

`ProtectedRoute` redirects to `/login` if `useAuth().user` is null.

---

## Step 1.11 — Run Migrations & Test

```bash
# Set up .env for development
cat > .env << 'EOF'
DATABASE_URL=postgresql://docnet:yourpassword@localhost:5432/docnet
JWT_SECRET=dev-secret-change-in-production-minimum-32-chars
ANTHROPIC_API_KEY=sk-ant-...
UPLOAD_DIR=./uploads
NODE_ENV=development
EOF

# Run migrations
npx tsx db/migrate.ts

# Build frontend
cd network-ui && npm run build && cd ..

# Start server
npx tsx api_server.ts
```

---

## Phase 1 Verification Checklist

- [ ] `npx tsx db/migrate.ts` runs without errors, all 3 migration files applied
- [ ] `POST /api/auth/register` with valid data returns `{ token, user }`
- [ ] `POST /api/auth/register` with duplicate email returns 409
- [ ] `POST /api/auth/login` with correct credentials returns token
- [ ] `POST /api/auth/login` with wrong password returns 401
- [ ] `GET /api/auth/me` with valid token returns user
- [ ] `GET /api/auth/me` without token returns 401
- [ ] `GET /api/projects` returns list (including default project from registration)
- [ ] `POST /api/projects` creates a new project
- [ ] `GET /api/projects/:id` with another user's project ID returns 404
- [ ] Browser: `/login` page renders, login works, redirects to `/projects`
- [ ] Browser: `/projects` shows project list
- [ ] Browser: `/projects/:id` shows graph page (empty, no data yet)
- [ ] Browser: accessing `/projects` without login redirects to `/login`
- [ ] `npm run build` in `network-ui/` succeeds
