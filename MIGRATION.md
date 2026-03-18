# Migration Checklist: Epstein-specific → Config-driven

This file is a **precise, exhaustive list of every change** needed to generalize
the codebase. Work through it top-to-bottom. Check off each item as you complete it.

Each entry lists:
- **File** – exact path
- **Find** – the string or pattern to locate (search the file for this)
- **Replace with** – the config-driven replacement
- **Why** – context

---

## Phase 1 – Create Config Infrastructure

### 1.1 Create `config.ts` (new file, root)

Create `/config.ts` that reads and validates `docnet.config.json`.

```typescript
import fs from 'fs';
import path from 'path';

export interface DocNetConfig {
  project: {
    name: string;
    description: string;
    repoUrl: string | null;
    accentColor: string;
  };
  principal: {
    name: string | null;
    aliases: string[];
    hopFilterDefault: number | null;
    hopFilterEnabled: boolean;
  };
  analysis: {
    model: string;
    documentCategories: string[];
    yearRangeMin: number;
    yearRangeMax: number;
    includeUndatedDefault: boolean;
  };
  ui: {
    welcomeTitle: string;
    welcomeBody: string;
    howToUse: string[];
    searchPlaceholder: string;
    defaultRelationshipLimit: number;
    mobileRelationshipLimit: number;
    aiAttributionNote: string;
  };
  export: {
    enabled: boolean;
    outputPath: string;
    includeFullText: boolean;
  };
  server: {
    port: number;
    dbPath: string;
    allowedOrigins: string[];
  };
}

function loadConfig(): DocNetConfig {
  const configPath = path.join(process.cwd(), 'docnet.config.json');
  if (!fs.existsSync(configPath)) {
    console.error('❌ docnet.config.json not found. Copy docnet.config.example.json to get started.');
    process.exit(1);
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as DocNetConfig;
  } catch (e) {
    console.error('❌ Failed to parse docnet.config.json:', e);
    process.exit(1);
  }
}

export const config = loadConfig();
```

### 1.2 Create `network-ui/src/config.ts` (new file)

```typescript
// All values injected at build time via Vite environment variables.
// These are set by build.sh reading docnet.config.json.

export const uiConfig = {
  projectName:      import.meta.env.VITE_PROJECT_NAME      || 'Document Network',
  welcomeTitle:     import.meta.env.VITE_WELCOME_TITLE     || 'Welcome',
  welcomeBody:      import.meta.env.VITE_WELCOME_BODY      || '',
  howToUse:         JSON.parse(import.meta.env.VITE_HOW_TO_USE || '[]') as string[],
  searchPlaceholder:import.meta.env.VITE_SEARCH_PLACEHOLDER || 'Search entities...',
  repoUrl:          import.meta.env.VITE_REPO_URL          || null,
  accentColor:      import.meta.env.VITE_ACCENT_COLOR      || 'blue',
  aiAttributionNote:import.meta.env.VITE_AI_ATTRIBUTION_NOTE || '',
  principalName:    import.meta.env.VITE_PRINCIPAL_NAME    || '',
  hopFilterEnabled: import.meta.env.VITE_HOP_FILTER_ENABLED === 'true',
  yearRangeMin:     parseInt(import.meta.env.VITE_YEAR_RANGE_MIN || '1970'),
  yearRangeMax:     parseInt(import.meta.env.VITE_YEAR_RANGE_MAX || '2025'),
  defaultLimit:     parseInt(import.meta.env.VITE_DEFAULT_LIMIT  || '9600'),
  mobileLimit:      parseInt(import.meta.env.VITE_MOBILE_LIMIT   || '3000'),
  includeUndatedDefault: import.meta.env.VITE_INCLUDE_UNDATED_DEFAULT === 'true',
} as const;
```

---

## Phase 2 – Backend Hardcodes (`api_server.ts`)

### 2.1 Import config

**Find (top of file, add after existing imports):**
```typescript
import express from 'express';
```

**Add:**
```typescript
import { config } from './config';
```

### 2.2 Port and DB path

**Find:**
```typescript
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || 'document_analysis.db';
```

**Replace with:**
```typescript
const PORT = process.env.PORT || config.server.port;
const DB_PATH = process.env.DB_PATH || config.server.dbPath;
```

### 2.3 CORS allowed origins

**Find:**
```typescript
: ['http://localhost:5173', 'http://localhost:3000', 'https://epsteinvisualizer.com', 'https://www.epsteinvisualizer.com'];
```

**Replace with:**
```typescript
: ['http://localhost:5173', 'http://localhost:3000', ...config.server.allowedOrigins];
```

### 2.4 Principal name constant

**Find:**
```typescript
const EPSTEIN_NAME = 'Jeffrey Epstein';
```

**Replace with:**
```typescript
const PRINCIPAL_NAME = config.principal.name;
```

### 2.5 BFS hop-distance calculation

**Find:**
```typescript
// BFS to calculate distances from Jeffrey Epstein
const distances = new Map<string, number>();
const queue: string[] = [];

if (adjacency.has(EPSTEIN_NAME)) {
  distances.set(EPSTEIN_NAME, 0);
  queue.push(EPSTEIN_NAME);
  // ...
}
```

**Replace with:**
```typescript
// BFS to calculate distances from principal (if configured)
const distances = new Map<string, number>();
const queue: string[] = [];

if (PRINCIPAL_NAME && adjacency.has(PRINCIPAL_NAME)) {
  distances.set(PRINCIPAL_NAME, 0);
  queue.push(PRINCIPAL_NAME);
  // ...
}
```

### 2.6 Hop filter guards in `/api/relationships`

Both hop JOIN/WHERE blocks are already guarded by `if (maxHops !== null)`.
However, add an outer guard:

**Find (in the `maxHops !== null` block):**
```typescript
if (maxHops !== null) {
  hopJoins = `...`;
  hopWhere = `...`;
```

**Replace with:**
```typescript
if (maxHops !== null && config.principal.hopFilterEnabled) {
  hopJoins = `...`;
  hopWhere = `...`;
```

Apply the same change in `/api/actor/:name/relationships`.

---

## Phase 3 – Analysis Pipeline (`analysis_pipeline/analyze_documents.ts`)

### 3.1 Import config

**Add at top of file:**
```typescript
import { config } from '../config';
```

### 3.2 Model constant

**Find:**
```typescript
const ANALYSIS_MODEL = 'claude-haiku-4-5';
```

**Replace with:**
```typescript
const ANALYSIS_MODEL = config.analysis.model;
```

### 3.3 Principal context preamble

**Find (the hardcoded block in `analyzeDocument()`):**
```
**CRITICAL IDENTIFICATION RULES:**
This document may contain communications involving Jeffrey Epstein. He may appear under these identifiers:
- Email: jeeitunes@gmail.com
- Email: e:jeeitunes@gmail.com
- Name: jee
- Name: Jeffrey Epstein
- Name: Jeffrey
- Name: Epstein

When you see ANY of these identifiers as a sender, participant, or actor, you MUST use "Jeffrey Epstein" as the actor name in your RDF triples. DO NOT use "jee", "unknown person", or any other placeholder.
```

**Replace with a function call:**
```typescript
function buildPrincipalContext(): string {
  const p = config.principal;
  if (!p.name) return '';
  
  const aliasBullets = p.aliases.map(a => `- ${a}`).join('\n');
  
  return `
**PRINCIPAL ENTITY IDENTIFICATION:**
This document collection centers on: ${p.name}

This entity may appear under these alternative identifiers:
${aliasBullets || '(no aliases configured)'}

When you see ANY of these identifiers as a sender, participant, or actor, you MUST use "${p.name}" as the canonical actor name in your RDF triples.
`.trim();
}
```

In `analyzeDocument()`, replace the hardcoded section with:
```typescript
const principalSection = buildPrincipalContext();
const principalBlock = principalSection
  ? `\n${principalSection}\n`
  : '';
```

And inject `principalBlock` into the prompt template where the hardcoded block was.

### 3.4 Document categories in prompt

**Find (in the JSON schema section of the prompt):**
```
"category": "One of: court_filing, email, letter, memorandum, report, transcript, financial_document, media_article, book_excerpt, photo_caption, mixed_document, public record, other",
```

**Replace with:**
```typescript
`"category": "One of: ${config.analysis.documentCategories.join(', ')}",`
```

### 3.5 Hardcoded actor examples in prompt

**Find:**
```
- ✅ Good: actor: "Jeffrey Epstein" (when you see jeeitunes@gmail.com or jee)
- ✅ Good: actor: "Donald Trump", "Ghislaine Maxwell"
- ❌ Bad: actor: "jee" (use "Jeffrey Epstein" instead)
```

**Replace with:**
```typescript
const actorExamples = config.principal.name
  ? `- ✅ Good: actor: "${config.principal.name}" (when you see their aliases)
  - ✅ Good: actor: "Full Name of Person"
  - ❌ Bad: Using an alias instead of the canonical name`
  : `- ✅ Good: actor: "Full Name of Person"
  - ❌ Bad: actor: "FBI" (organization), actor: "the investigation" (abstract)`;
```

### 3.6 Year range timestamp filter in SQL

**Find:**
```sql
WHERE (rt.timestamp IS NULL OR rt.timestamp >= '1970-01-01')
```

**Replace with:**
```typescript
`WHERE (rt.timestamp IS NULL OR rt.timestamp >= '${config.analysis.yearRangeMin}-01-01')`
```

(Apply in both the relationships and actor-relationships queries in `api_server.ts` too)

### 3.7 Principal alias pre-seeding in DB init

**Find** the `initDatabase()` function. **After** the `entity_aliases` table is
created (or after existing indexes), add:

```typescript
// Pre-seed principal aliases from config
if (config.principal.name && config.principal.aliases.length > 0) {
  const insertAlias = db.prepare(`
    INSERT OR IGNORE INTO entity_aliases (original_name, canonical_name, reasoning, created_by)
    VALUES (?, ?, 'Configured in docnet.config.json', 'config')
  `);
  const insertMany = db.transaction((aliases: string[]) => {
    for (const alias of aliases) {
      insertAlias.run(alias, config.principal.name);
    }
  });
  insertMany(config.principal.aliases);
  console.log(`✓ Seeded ${config.principal.aliases.length} principal aliases`);
}
```

---

## Phase 4 – Frontend Components

### 4.1 `Sidebar.tsx`

**Import config at top:**
```typescript
import { uiConfig } from '../config';
```

**Find (header section):**
```tsx
<h1 className="font-bold text-blue-400" style={{ fontSize: '20px' }}>
  📊 The Epstein Network
</h1>
<a href="https://github.com/maxandrews/Epstein-doc-explorer" ...>
```

**Replace with:**
```tsx
<h1 className="font-bold text-blue-400" style={{ fontSize: '20px' }}>
  📊 {uiConfig.projectName}
</h1>
{uiConfig.repoUrl && (
  <a href={uiConfig.repoUrl} target="_blank" rel="noopener noreferrer" ...>
    <span className="underline">Github Repo</span>
    ...
  </a>
)}
```

**Find (hop distance slider label):**
```tsx
Maximum hops from Jeffrey Epstein: {maxHops === null ? 'Any' : maxHops}
```

**Replace with:**
```tsx
Maximum hops from {uiConfig.principalName}: {maxHops === null ? 'Any' : maxHops}
```

**Find (entire hop distance slider `<div>`):**
Wrap in:
```tsx
{uiConfig.hopFilterEnabled && (
  <div className="mb-4">
    {/* ... existing hop slider ... */}
  </div>
)}
```

**Find (search placeholder):**
```tsx
placeholder="e.g., Jeffrey Epstein"
```

**Replace with:**
```tsx
placeholder={uiConfig.searchPlaceholder}
```

**Find (year range slider hardcoded bounds):**
```tsx
min="1970" max="2025"
```

**Replace with:**
```tsx
min={uiConfig.yearRangeMin} max={uiConfig.yearRangeMax}
```

Also update the display labels:
```tsx
// Find:
<span>1970</span>  ... <span>2025</span>
// Replace:
<span>{uiConfig.yearRangeMin}</span> ... <span>{uiConfig.yearRangeMax}</span>
```

### 4.2 `WelcomeModal.tsx`

**Import config:**
```typescript
import { uiConfig } from '../config';
```

**Find:**
```tsx
<h2 className="text-2xl font-bold mb-4 text-white">
  Welcome to the Epstein Document Network Explorer
</h2>
```

**Replace with:**
```tsx
<h2 className="text-2xl font-bold mb-4 text-white">
  {uiConfig.welcomeTitle}
</h2>
```

**Find (the three hardcoded `<p>` paragraphs):**
```tsx
<p>This is a network analysis tool for exploring relationships between people, places,
   and events captured in the Epstein emails released by the House Oversight Committee.</p>
<p>LLMs were used to extract these relationships from the raw document text, ...</p>
<p>Click on a relationship in the timeline after selecting or searching ...</p>
```

**Replace with:**
```tsx
<p className="whitespace-pre-line">{uiConfig.welcomeBody}</p>
<p className="text-sm text-gray-400 italic mt-2">{uiConfig.aiAttributionNote}</p>
```

**Find (the hardcoded "How to use" bullets):**
```tsx
<li>Search for actors using the search bar</li>
<li>Click on nodes in the graph to explore their relationships</li>
...
```

**Replace with:**
```tsx
{uiConfig.howToUse.map((tip, i) => (
  <li key={i}>{tip}</li>
))}
```

### 4.3 `App.tsx`

**Find:**
```typescript
const [limit, setLimit] = useState(isMobile ? 5000 : 9600);
const [maxHops, setMaxHops] = useState<number | null>(3);
const [includeUndated, setIncludeUndated] = useState(false);
```

**Replace with:**
```typescript
import { uiConfig } from './config';

const [limit, setLimit] = useState(isMobile ? uiConfig.mobileLimit : uiConfig.defaultLimit);
const [maxHops, setMaxHops] = useState<number | null>(
  uiConfig.hopFilterEnabled ? (config.principal?.hopFilterDefault ?? 3) : null
);
const [includeUndated, setIncludeUndated] = useState(uiConfig.includeUndatedDefault);
```

### 4.4 `MobileBottomNav.tsx`

**Find** any instance of:
```tsx
Maximum hops from Jeffrey Epstein
```

**Replace with:**
```tsx
{uiConfig.hopFilterEnabled && (
  <span>Maximum hops from {uiConfig.principalName}</span>
)}
```

Also wrap the mobile hop-distance slider in `{uiConfig.hopFilterEnabled && (...)}`.

### 4.5 `network-ui/index.html`

**Find:**
```html
<title>network-ui</title>
```

**Replace with:**
(This is injected by `build.sh` — do not hardcode the title here)
```html
<title>%VITE_PROJECT_NAME%</title>
```

Vite resolves `%VITE_*%` variables in `index.html` automatically.

---

## Phase 5 – Build Script (`build.sh`)

Replace the current minimal `build.sh` with a config-aware version:

```bash
#!/bin/bash
set -e

echo "=== Reading docnet.config.json ==="

# Validate config exists
if [ ! -f "docnet.config.json" ]; then
  echo "❌ docnet.config.json not found. Copy docnet.config.example.json first."
  exit 1
fi

# Extract config values using node (avoids dependency on jq)
PROJECT_NAME=$(node -e "console.log(require('./docnet.config.json').project.name)")
WELCOME_TITLE=$(node -e "console.log(require('./docnet.config.json').ui.welcomeTitle)")
WELCOME_BODY=$(node -e "console.log(require('./docnet.config.json').ui.welcomeBody)")
HOW_TO_USE=$(node -e "console.log(JSON.stringify(require('./docnet.config.json').ui.howToUse))")
SEARCH_PLACEHOLDER=$(node -e "console.log(require('./docnet.config.json').ui.searchPlaceholder)")
REPO_URL=$(node -e "const v = require('./docnet.config.json').project.repoUrl; console.log(v || '')")
ACCENT_COLOR=$(node -e "console.log(require('./docnet.config.json').project.accentColor)")
AI_ATTRIBUTION_NOTE=$(node -e "console.log(require('./docnet.config.json').ui.aiAttributionNote)")
PRINCIPAL_NAME=$(node -e "const v = require('./docnet.config.json').principal.name; console.log(v || '')")
HOP_FILTER_ENABLED=$(node -e "console.log(require('./docnet.config.json').principal.hopFilterEnabled)")
YEAR_RANGE_MIN=$(node -e "console.log(require('./docnet.config.json').analysis.yearRangeMin)")
YEAR_RANGE_MAX=$(node -e "console.log(require('./docnet.config.json').analysis.yearRangeMax)")
DEFAULT_LIMIT=$(node -e "console.log(require('./docnet.config.json').ui.defaultRelationshipLimit)")
MOBILE_LIMIT=$(node -e "console.log(require('./docnet.config.json').ui.mobileRelationshipLimit)")
INCLUDE_UNDATED_DEFAULT=$(node -e "console.log(require('./docnet.config.json').analysis.includeUndatedDefault)")

echo "  Project: $PROJECT_NAME"
echo "  Principal: ${PRINCIPAL_NAME:-'(none)'}"

echo "=== Writing frontend environment ==="
cat > network-ui/.env.production << EOF
VITE_PROJECT_NAME=$PROJECT_NAME
VITE_WELCOME_TITLE=$WELCOME_TITLE
VITE_WELCOME_BODY=$WELCOME_BODY
VITE_HOW_TO_USE=$HOW_TO_USE
VITE_SEARCH_PLACEHOLDER=$SEARCH_PLACEHOLDER
VITE_REPO_URL=$REPO_URL
VITE_ACCENT_COLOR=$ACCENT_COLOR
VITE_AI_ATTRIBUTION_NOTE=$AI_ATTRIBUTION_NOTE
VITE_PRINCIPAL_NAME=$PRINCIPAL_NAME
VITE_HOP_FILTER_ENABLED=$HOP_FILTER_ENABLED
VITE_YEAR_RANGE_MIN=$YEAR_RANGE_MIN
VITE_YEAR_RANGE_MAX=$YEAR_RANGE_MAX
VITE_DEFAULT_LIMIT=$DEFAULT_LIMIT
VITE_MOBILE_LIMIT=$MOBILE_LIMIT
VITE_INCLUDE_UNDATED_DEFAULT=$INCLUDE_UNDATED_DEFAULT
EOF

echo "=== Installing root dependencies ==="
npm install

echo "=== Installing frontend dependencies ==="
cd network-ui
npm install

echo "=== Building frontend ==="
npm run build

echo "=== Verifying build ==="
if [ -d "dist" ]; then
  echo "✓ Frontend build successful"
else
  echo "✗ Frontend build failed"
  exit 1
fi

cd ..
echo "=== Build complete ==="
echo "Run: npx tsx api_server.ts"
```

---

## Phase 6 – Database Schema Extensions

### 6.1 Add `project_id` to all tables (forward compat for Variant B)

In `analysis_pipeline/analyze_documents.ts`, in `initDatabase()`, update the
`CREATE TABLE IF NOT EXISTS` statements:

**`documents` table — add column:**
```sql
project_id TEXT NOT NULL DEFAULT 'default',
```
After `id INTEGER PRIMARY KEY AUTOINCREMENT,` and update the UNIQUE constraint:
```sql
UNIQUE(project_id, doc_id)
```

**`rdf_triples` table — add column:**
```sql
project_id TEXT NOT NULL DEFAULT 'default',
```

**`entity_aliases` table — add column:**
```sql
project_id TEXT NOT NULL DEFAULT 'default',
```
And update the PRIMARY KEY to `PRIMARY KEY(project_id, original_name)`.

### 6.2 Add `docnet_metadata` table (forward compat for Variant E)

```sql
CREATE TABLE IF NOT EXISTS docnet_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

After creating this table, insert the config snapshot:
```typescript
const configSnapshot = JSON.stringify(config);
db.prepare(`
  INSERT OR REPLACE INTO docnet_metadata (key, value) VALUES ('config', ?)
`).run(configSnapshot);
db.prepare(`
  INSERT OR REPLACE INTO docnet_metadata (key, value) VALUES ('created_at', ?)
`).run(new Date().toISOString());
```

---

## Phase 7 – `IStorageAdapter` Abstraction

### 7.1 Create `storage/IStorageAdapter.ts` (new file)

```typescript
export interface RelationshipParams {
  limit: number;
  clusterIds: number[];
  categories: string[];
  yearRange?: [number, number];
  includeUndated: boolean;
  keywords: string[];
  maxHops?: number | null;
}

export interface IStorageAdapter {
  getStats(): any;
  getTagClusters(): any[];
  getRelationships(params: RelationshipParams): any;
  getActorRelationships(name: string, params: RelationshipParams): any;
  searchActors(query: string): any[];
  getActorCount(name: string): number;
  getActorCounts(limit: number): Record<string, number>;
  getDocument(docId: string): any | null;
  getDocumentText(docId: string): string | null;
}
```

### 7.2 Create `storage/SqliteAdapter.ts` (new file)

Move all database query logic from `api_server.ts` into this class, implementing
`IStorageAdapter`. `api_server.ts` becomes thin route handlers that call
`adapter.getRelationships(params)` etc.

The adapter is instantiated in `api_server.ts`:
```typescript
import { SqliteAdapter } from './storage/SqliteAdapter';
const adapter = new SqliteAdapter(DB_PATH, tagClusters, config);
```

This is the **most important structural change** — it makes Variant E's
`SqlJsAdapter` a drop-in replacement.

---

## Phase 8 – Verification Checklist

After all changes are applied, verify:

- [ ] `grep -r "Jeffrey Epstein" --include="*.ts" --include="*.tsx" .` returns 0 results
- [ ] `grep -r "Epstein" --include="*.ts" --include="*.tsx" .` returns 0 results (except comments)
- [ ] `grep -r "epsteinvisualizer" . ` returns 0 results
- [ ] `grep -r "jeeitunes@gmail" .` returns 0 results
- [ ] `grep -r "The Epstein Network" .` returns 0 results
- [ ] `grep -r "1970\|2025" --include="*.ts" --include="*.tsx" .` returns only `config.ts`
- [ ] `npm run build` in `network-ui/` succeeds with an empty `docnet.config.json` (using example)
- [ ] Server starts: `npx tsx api_server.ts`
- [ ] UI loads with project name from config
- [ ] Hop filter is hidden when `hopFilterEnabled: false`
- [ ] Hop filter is visible with correct principal name when `hopFilterEnabled: true`
- [ ] Welcome modal shows config-driven title and body
- [ ] Search placeholder shows config-driven value
- [ ] Year range slider uses config-driven min/max

---

## Files NOT to Touch

These files are domain-neutral and require no changes:

- `analysis_pipeline/cluster_tags.ts` – pure math, no domain content
- `analysis_pipeline/dedupe_with_llm.ts` – generic LLM deduplication
- `analysis_pipeline/update_top_clusters.ts` – pure DB migration
- `network-ui/src/components/NetworkGraph.tsx` – pure visualization
- `network-ui/src/components/RightSidebar.tsx` – generic relationship display
- `network-ui/src/components/DocumentModal.tsx` – generic document viewer
- `network-ui/src/types.ts` – generic TypeScript types
- `network-ui/src/api.ts` – generic HTTP client (no hardcodes)
- `tsconfig.json`, `package.json` – no changes needed
