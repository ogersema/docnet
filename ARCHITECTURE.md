# Architecture Decisions

This document explains the structural choices made during the Variant A
generalization and how they enable Variants E (Hybrid), B (SaaS), and C
(Desktop) without requiring rewrites.

---

## Decision 1: `IStorageAdapter` Interface

**What it is:**  
All database access in `api_server.ts` goes through a single interface
(`storage/IStorageAdapter.ts`) rather than calling `better-sqlite3` directly.
The current implementation is `SqliteAdapter`.

**Why it matters for future variants:**

| Variant | Storage implementation |
|---|---|
| A (current) | `SqliteAdapter` – wraps `better-sqlite3`, local file |
| E (Hybrid) | `SqlJsAdapter` – wraps `sql.js` (WebAssembly), runs in browser |
| B (SaaS) | `PostgresAdapter` – wraps `pg` or `drizzle-orm`, multi-tenant |
| C (Desktop) | `SqliteAdapter` unchanged (same local file, Electron/Tauri shell) |

**For Variant E specifically:**  
The static frontend needs to query the database without a server. `sql.js` 
compiles SQLite to WebAssembly and runs entirely in the browser. Because the
adapter interface is identical, the React components and API client don't know
or care which implementation they're talking to. The E build simply swaps
`SqliteAdapter` for `SqlJsAdapter` and removes the Express server.

**Rule:** Never add `import Database from 'better-sqlite3'` to any file other
than `storage/SqliteAdapter.ts`.

---

## Decision 2: `project_id` Column in All Tables

**What it is:**  
Every database table has a `project_id TEXT NOT NULL DEFAULT 'default'` column.
In Variant A it is always `'default'`.

**Why it matters for Variant B:**  
Variant B is a multi-tenant SaaS where each user has multiple projects. Adding
`project_id` now means the PostgreSQL migration is:
1. Change column type from SQLite to PostgreSQL equivalents
2. Add a `projects` table and `users` table
3. Replace `DEFAULT 'default'` with the actual user's project UUID

If `project_id` weren't there from the start, every query, every index, every
unique constraint would need updating — a major migration risk with existing data.

**Rule:** Always filter queries by `project_id`. In Variant A, always pass
`'default'`. Never rely on the default value in application code.

---

## Decision 3: `docnet_metadata` Table

**What it is:**  
A key-value table in SQLite that stores the config snapshot used when the
analysis was run.

```sql
CREATE TABLE docnet_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Keys: 'config', 'created_at', 'project_name', 'version'
```

**Why it matters for Variant E:**  
Variant E bundles the SQLite database into a portable `.docnet` file. When
someone opens this file, the static frontend needs to know the project name,
year range, cluster count etc. — without a separate `docnet.config.json`.

By storing the config snapshot in the database itself, the `.docnet` file is
**self-describing**: a single file contains both the data and the metadata
needed to display it correctly.

**Rule:** Always write the config snapshot to `docnet_metadata` at the end of
`analyze_documents.ts`. Future migration scripts should also update it.

---

## Decision 4: Config-Driven AI Prompt (no hardcoded domain)

**What it is:**  
The analysis prompt in `analyze_documents.ts` has zero hardcoded domain
references. Everything domain-specific comes from `config`:
- Principal name and aliases → `config.principal`
- Document categories → `config.analysis.documentCategories`
- Actor naming examples → generated from config

**Why it matters:**  
The AI prompt is the most important part of the system — it determines the
quality of extracted data. Making it config-driven means the same codebase
can analyze:
- Legal documents (categories: `court_filing`, `deposition`, `exhibit`)
- Medical records (categories: `clinical_note`, `lab_report`, `prescription`)
- Corporate documents (categories: `memo`, `contract`, `board_minutes`)
- Investigative journalism (categories: `source_document`, `leaked_file`, `public_record`)

Each corpus gets exactly the right framing without touching source code.

**Rule:** If you find yourself wanting to add domain-specific text to the AI
prompt, ask whether it belongs in `config.analysis` instead.

---

## Decision 5: Build-Time Frontend Config (not runtime)

**What it is:**  
The frontend reads project identity (name, colors, welcome text) from
`VITE_*` environment variables injected at build time by `build.sh`.

**Alternative considered:** A `/api/config` endpoint that the frontend fetches
at runtime.

**Why build-time is better for Variant E:**  
Variant E has no server. The frontend is a static bundle. Build-time injection
means the `.docnet` bundle already has the project name baked in — no API call
needed.

**Why build-time is fine for Variant B:**  
In Variant B, each project gets its own deployment (or subdomain), so the
build-time config is project-specific anyway. If B eventually needs a shared
SPA with per-user projects, the frontend can be changed to read from an API
endpoint — but the `uiConfig` interface stays the same.

**Rule:** All UI strings come from `uiConfig` (imported from `src/config.ts`).
Never read `import.meta.env.VITE_*` directly in components.

---

## Decision 6: Export Hook in Analysis Pipeline

**What it is:**  
At the end of `analyze_documents.ts main()`, there is a call to an export hook:

```typescript
if (config.export?.enabled) {
  await runExportHook(db, config);
}
```

`runExportHook` is a no-op function in Variant A.

**Why it matters for Variant E:**  
Variant E's export hook:
1. Reads the fully-analyzed SQLite database
2. Copies `tag_clusters.json` and the config snapshot
3. Bundles everything into a `.docnet` zip archive
4. Optionally encrypts with a user-supplied password (via `staticrypt` or `libsodium`)
5. Outputs to `config.export.outputPath`

The user's workflow becomes:
```bash
# Analyze
npx tsx analysis_pipeline/analyze_documents.ts
# → writes export.docnet automatically

# Share: upload export.docnet to Netlify Drop
# Anyone with the link can open it in the browser
```

**Rule:** Keep `runExportHook` as a named, importable function in its own file
(`export/runExportHook.ts`). Don't inline it in the main pipeline script.

---

## Decision 7: What Variant B/C Adds (not changes)

Variants B and C don't require changing the core architecture — they add layers
on top:

**Variant B (SaaS) adds:**
- `auth/` – authentication middleware (JWT or session)
- `routes/projects.ts` – CRUD for projects
- `routes/upload.ts` – file upload → S3 → job queue
- `queue/` – BullMQ workers that run `analyze_documents.ts` for each project
- `PostgresAdapter` – implements `IStorageAdapter` for PostgreSQL
- `network-ui/src/pages/` – project selector, auth screens

**Variant C (Desktop) adds:**
- `electron/` or `tauri/` – shell and native file picker
- `electron/main.ts` – starts the Express API server in the background
- `electron/preload.ts` – exposes native file dialog to renderer
- No changes to `api_server.ts`, `analyze_documents.ts`, or React components

**The core stays the same.** That is the point of this architecture.

---

## Dependency Philosophy

| Layer | Key Dependencies | Why |
|---|---|---|
| Backend | `express`, `better-sqlite3`, `cors` | Minimal, stable, well-understood |
| AI | `@anthropic-ai/sdk` | Direct API access, no abstraction |
| Frontend | `react`, `vite`, `tailwind`, `react-force-graph-2d` | Each is best-in-class for its job |
| Types | `typescript` strict | Catches bugs across the interface boundaries |

**Deliberately avoided:**
- ORMs (Prisma, Drizzle) — add abstraction that conflicts with raw SQLite performance
- State management libraries (Redux, Zustand) — React state is sufficient for this UI
- CSS-in-JS — Tailwind is simpler and faster for this use case
- GraphQL — REST is simpler and sufficient; GraphQL adds complexity without benefit here

---

## Performance Constraints

- `top_cluster_ids` is a **materialized column** — always keep it in sync after
  tag clustering. Queries filtering by cluster that hit the full `triple_tags`
  JSON column are 10x slower.
- The `MAX_DB_LIMIT = 100000` cap in `/api/relationships` prevents OOM crashes.
  Do not raise it without profiling memory usage.
- `sql.js` (Variant E) will be noticeably slower than `better-sqlite3` for
  databases over 50 MB. The `.docnet` export should offer an option to strip
  `full_text` from documents (which is typically 60–80% of database size) to
  keep bundles under 30 MB.

---

## Security Notes

- All SQL uses prepared statements. Never interpolate user input into SQL strings.
- `maxHops` is validated to be an integer 1–10 before use in SQL.
- `actor` name in the URL is validated for length before use.
- Rate limiting is applied globally (1000 req/15 min per IP).
- In Variant B, add per-project authorization middleware to every route.
- The `ALLOWED_ORIGINS` CORS list must be explicit in production — never use `*`.
