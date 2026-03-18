# DocNet – Document Network Explorer
## Claude Code Project Bible — Variant B (Multi-User, Self-Hosted)

> This file supersedes the Variant A CLAUDE.md.
> Read it completely before making any changes.
> When in doubt: read this file, then the relevant PHASE_X.md, then act.

---

## What This Project Is

A self-hosted, multi-user document analysis and network visualization platform.
Reporters upload PDF files or submit URLs. The system uses Claude AI to extract
structured relationships (RDF triples: Actor → Action → Target), stores them
per-project in PostgreSQL, and visualizes them as an interactive force-directed
knowledge graph.

Hosted on a Hetzner VPS. Accessed via browser. No terminal required for
end users (reporters). Admins manage the server; reporters use the web UI.

---

## Architecture Overview

```
Browser (Reporter)
      │
      ▼
nginx (port 80/443, TLS via Let's Encrypt)
      │
      ├── /api/*  ──▶  Express API Server (Node, port 3001)
      │                    │
      │                    ├── Auth middleware (JWT)
      │                    ├── Routes: auth, users, projects, upload, jobs, graph
      │                    ├── PostgresAdapter (implements IStorageAdapter)
      │                    └── File storage (PDFs on disk: /var/docnet/uploads/)
      │
      └── /*  ──▶  Static React build (served by nginx from /var/docnet/dist/)

Background Processes (managed by PM2):
  - api_server          (Express, always on)
  - analysis_worker     (Job queue consumer, always on)
```

---

## Critical Rules

### 1. Security-First
Every API endpoint that touches user data **must** go through `authMiddleware`.
No exceptions. Every database query **must** filter by `project_id` AND verify
that the project belongs to the requesting user.

Never trust `project_id` from request body — always derive it from the
authenticated user's session or verify ownership explicitly.

### 2. Project Isolation
A user must never see another user's data. This is the invariant that must
hold everywhere:
- All queries include `WHERE project_id = $1`
- All file paths include the project UUID as a directory prefix
- Upload endpoints verify project ownership before writing

### 3. Async by Default
Document analysis (PDF and web) is slow. It must never happen synchronously
in an HTTP request handler. Every analysis task goes through the job queue.
The API returns `{ jobId }` immediately. The client polls `/api/jobs/:id`.

### 4. PostgreSQL Only
No `better-sqlite3` imports anywhere except `storage/SqliteAdapter.ts`
(kept for Variant A compatibility). All Variant B code uses `pg` via
`storage/PostgresAdapter.ts`.

### 5. Fail Loudly in Development
In development (`NODE_ENV !== 'production'`), crashes should be noisy.
In production, all unhandled errors go to a log file, not stdout, and
the process stays alive (PM2 handles restarts).

---

## Repository Structure (Variant B)

```
docnet/
├── CLAUDE.md                        ← You are here (V2)
├── docnet.config.json               ← Still used for analysis config
│
├── api_server.ts                    ← Express entry point
├── build.sh                         ← Build script (now also runs DB migrations)
│
├── auth/
│   ├── middleware.ts                ← JWT verification, attaches req.user
│   ├── passwords.ts                 ← bcrypt helpers
│   └── tokens.ts                    ← JWT sign/verify helpers
│
├── routes/
│   ├── auth.ts                      ← POST /api/auth/register, /login, /logout
│   ├── projects.ts                  ← CRUD /api/projects
│   ├── upload.ts                    ← POST /api/projects/:id/upload (PDF + URL)
│   ├── jobs.ts                      ← GET /api/jobs/:id (status polling)
│   └── graph.ts                     ← All graph/analysis endpoints (from api_server.ts)
│
├── worker/
│   ├── index.ts                     ← Worker entry point (run by PM2 separately)
│   ├── queue.ts                     ← Job queue (PostgreSQL-backed)
│   ├── processors/
│   │   ├── pdf.ts                   ← PDF extraction + analysis
│   │   └── web.ts                   ← Web crawler + analysis
│   └── pipeline.ts                  ← Shared analysis logic (calls Claude API)
│
├── storage/
│   ├── IStorageAdapter.ts           ← Interface (unchanged from V1)
│   ├── SqliteAdapter.ts             ← V1 implementation (keep, don't modify)
│   └── PostgresAdapter.ts           ← V2 implementation
│
├── db/
│   ├── schema.sql                   ← Complete PostgreSQL schema
│   ├── migrate.ts                   ← Migration runner
│   └── migrations/
│       ├── 001_initial.sql          ← Users, projects, base tables
│       ├── 002_jobs.sql             ← Job queue table
│       └── 003_crawler.sql          ← Web source tracking
│
├── analysis_pipeline/               ← Unchanged from V1 (still used by worker)
│
└── network-ui/                      ← React frontend (extended with new pages)
    └── src/
        ├── pages/
        │   ├── Login.tsx
        │   ├── Register.tsx
        │   ├── ProjectList.tsx      ← Dashboard: all user's projects
        │   ├── ProjectDetail.tsx    ← Upload + graph for one project
        │   └── Graph.tsx            ← Moved from App.tsx
        ├── components/              ← All existing components unchanged
        ├── hooks/
        │   ├── useAuth.ts           ← Auth context + JWT management
        │   └── useJobs.ts           ← Job status polling
        └── api.ts                   ← Extended with auth + project endpoints
```

---

## Database Schema (PostgreSQL)

### New tables (Variant B adds these)

```sql
-- Users
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reporter',   -- 'reporter' | 'admin'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Projects (one user can have many)
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  config JSONB,                            -- stores docnet.config.json overrides
  status TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'archived'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Job queue
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                      -- 'pdf' | 'web'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'running'|'done'|'error'
  payload JSONB NOT NULL,                  -- { filePath } or { url, depth }
  progress INTEGER DEFAULT 0,             -- 0–100
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Web sources (tracks crawled URLs per project)
CREATE TABLE web_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  crawled_at TIMESTAMPTZ DEFAULT NOW(),
  doc_count INTEGER DEFAULT 0
);
```

### Existing tables (modified for Variant B)

The `documents`, `rdf_triples`, `entity_aliases`, `canonical_entities`,
and `docnet_metadata` tables already have `project_id TEXT NOT NULL DEFAULT 'default'`.

In PostgreSQL, change `project_id TEXT` to `project_id UUID NOT NULL` with
a foreign key to `projects(id)`. Add `user_id UUID REFERENCES users(id)` to
`documents` for direct ownership queries.

---

## Auth Flow

```
POST /api/auth/register  { email, password, displayName }
  → hash password with bcrypt (rounds: 12)
  → insert into users
  → create default project for new user
  → return { token, user }

POST /api/auth/login  { email, password }
  → find user by email
  → bcrypt.compare
  → sign JWT: { userId, email, role }, expires 7d
  → return { token, user }

All protected routes:
  → Authorization: Bearer <token>
  → authMiddleware: verify JWT, attach req.user = { id, email, role }
  → ownership checks per route
```

JWT secret from `process.env.JWT_SECRET` (required in production).
Never hardcode a secret.

---

## Job Queue Pattern

```typescript
// Enqueueing (in upload route):
const job = await queue.enqueue({
  projectId: req.params.projectId,
  type: 'pdf',
  payload: { filePath: savedPath }
});
res.json({ jobId: job.id });

// Worker loop (worker/index.ts):
while (true) {
  const job = await queue.claim();   // SELECT ... FOR UPDATE SKIP LOCKED
  if (!job) { await sleep(2000); continue; }
  
  try {
    await queue.setRunning(job.id);
    await processJob(job);           // calls pdf.ts or web.ts
    await queue.setDone(job.id);
  } catch (err) {
    await queue.setError(job.id, err.message);
  }
}

// Client polling (useJobs.ts hook):
// GET /api/jobs/:id  every 3 seconds until status === 'done' | 'error'
```

---

## File Storage

Uploaded PDFs are stored at: `/var/docnet/uploads/{projectId}/{originalFilename}`
(or `./uploads/` in development, relative to project root).

Path is set via `UPLOAD_DIR` environment variable.
Default: `./uploads` (development), `/var/docnet/uploads` (production).

Never store file paths with user-controlled input unsanitized.
Always use `path.join(UPLOAD_DIR, projectId, sanitizedFilename)`.

---

## Web Crawler

Module: `worker/processors/web.ts`

```typescript
interface CrawlConfig {
  url: string;        // Starting URL
  maxDepth: number;   // 0 = only this page, 1 = linked pages, 2 = two levels
  domainOnly: boolean; // Only crawl pages on the same domain
  maxPages: number;   // Hard cap, default 50
}
```

Implementation strategy:
1. Use `node-fetch` + `cheerio` for static pages (fast)
2. Fall back to `playwright` for pages that require JS rendering
   (detect by checking if cheerio parse yields meaningful text)
3. Extract: title, main text content (strip nav/footer/sidebar)
4. Each page becomes one document entry, same pipeline as PDFs
5. Track crawled URLs in `web_sources` table (no duplicates per project)

Playwright is heavy — install it only if needed. Start with cheerio-only
and add playwright support in a second pass.

---

## Environment Variables (Production)

```bash
NODE_ENV=production
PORT=3001
DATABASE_URL=postgresql://docnet:PASSWORD@localhost:5432/docnet
JWT_SECRET=<random 64-char hex string>
ANTHROPIC_API_KEY=sk-ant-...
UPLOAD_DIR=/var/docnet/uploads
DIST_DIR=/var/docnet/dist
ACCESS_LOG=/var/log/docnet/access.log
ERROR_LOG=/var/log/docnet/error.log
```

---

## What Not to Change

- `storage/IStorageAdapter.ts` interface
- `analysis_pipeline/` directory (worker calls these directly)
- All existing React components in `network-ui/src/components/`
  (they are wrapped, not replaced — Graph.tsx is the new home of App.tsx logic)
- The `project_id` column naming convention
- The RDF triple schema (actor, action, target, etc.)
- The tag clustering format in `tag_clusters.json`

---

## Code Style

- TypeScript strict mode everywhere
- `async/await` only — no raw Promise chains
- All SQL via parameterized queries — never string concatenation
- UUIDs for all primary keys (PostgreSQL `gen_random_uuid()`)
- File: `camelCase.ts` backend, `PascalCase.tsx` React
- Routes: `routes/` files export Express Router, imported in `api_server.ts`
- Errors: always `{ error: string }` JSON with appropriate HTTP status
- Never `console.log` in production paths — use the logger utility
