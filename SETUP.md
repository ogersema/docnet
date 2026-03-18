# Claude Code Quickstart

## How to use these documents

You have four documents that together tell Claude Code exactly what to build:

| File | Purpose |
|---|---|
| `CLAUDE.md` | Place this in the **root of the cloned repo**. Claude Code reads it automatically on startup. Contains architecture, rules, and patterns. |
| `docnet.config.example.json` | Copy to `docnet.config.json` in the repo root. Fill in your project values. |
| `MIGRATION.md` | The step-by-step implementation guide. Hand this to Claude Code as the task specification. |
| `ARCHITECTURE.md` | Background reading for Claude Code when it needs to understand *why* something is structured a certain way. |

---

## Step-by-step instructions

### 1. Clone and prepare the repo

```bash
git clone https://github.com/maxandrews/Epstein-doc-explorer docnet
cd docnet
```

Copy the four documents from this package into the repo:

```bash
cp CLAUDE.md docnet/CLAUDE.md
cp docnet.config.example.json docnet/docnet.config.example.json
cp MIGRATION.md docnet/MIGRATION.md
cp ARCHITECTURE.md docnet/ARCHITECTURE.md
```

### 2. Start Claude Code

```bash
cd docnet
claude
```

Claude Code will automatically read `CLAUDE.md` on startup.

### 3. Give Claude Code the task

Paste this as your first message:

```
Read MIGRATION.md completely, then implement all changes in order
from Phase 1 through Phase 8.

After each phase, run the verification steps at the bottom
of MIGRATION.md that apply to that phase before moving to the next.

For any decision not covered in MIGRATION.md, consult ARCHITECTURE.md.
The rule in CLAUDE.md "Config-First" applies to every line you write.

Do not ask for confirmation between phases — work through the
entire checklist autonomously. Report progress at the start of
each phase.
```

### 4. Set up your project config

While Claude Code works, fill in `docnet.config.json`:

```json
{
  "project": {
    "name": "My Project Name",
    "description": "What this document collection is about.",
    "repoUrl": null,
    "accentColor": "blue"
  },
  "principal": {
    "name": null,
    "aliases": [],
    "hopFilterDefault": 3,
    "hopFilterEnabled": false
  },
  "analysis": {
    "model": "claude-haiku-4-5",
    "documentCategories": ["email", "letter", "report", "other"],
    "yearRangeMin": 2000,
    "yearRangeMax": 2025,
    "includeUndatedDefault": false
  },
  "ui": {
    "welcomeTitle": "Welcome to My Project",
    "welcomeBody": "This tool visualizes relationships extracted from my documents.",
    "howToUse": [
      "Search for entities using the search bar",
      "Click nodes in the graph to explore relationships",
      "Use filters to focus on specific topics"
    ],
    "searchPlaceholder": "Search entities...",
    "defaultRelationshipLimit": 9600,
    "mobileRelationshipLimit": 3000,
    "aiAttributionNote": "Relationships extracted by AI. Verify against source documents."
  },
  "export": { "enabled": false },
  "server": { "port": 3001, "dbPath": "document_analysis.db", "allowedOrigins": [] }
}
```

### 5. Verify the migration

Ask Claude Code to run the final verification checklist (Phase 8 in MIGRATION.md):

```
Run the Phase 8 verification checklist from MIGRATION.md.
Report each check as pass/fail, and fix any failures before reporting done.
```

### 6. Test with your documents

```bash
# Place PDFs in data/documents/
mkdir -p data/documents
cp /path/to/your/pdfs/*.pdf data/documents/

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...

# Run analysis (start small: move 5-10 PDFs in first)
npx tsx analysis_pipeline/analyze_documents.ts

# Start the app
npx tsx api_server.ts
# Open http://localhost:3001
```

---

## Common configuration scenarios

### Historical archive (no central person)
```json
"principal": { "name": null, "hopFilterEnabled": false },
"analysis": { "yearRangeMin": 1900, "yearRangeMax": 1990 }
```

### Corporate investigation (central company)
```json
"principal": {
  "name": "Acme Corporation",
  "aliases": ["Acme Corp", "Acme Inc", "ACME"],
  "hopFilterEnabled": true,
  "hopFilterDefault": 2
}
```

### Medical records
```json
"analysis": {
  "documentCategories": ["clinical_note", "lab_report", "discharge_summary",
    "prescription", "referral", "imaging_report", "other"],
  "yearRangeMin": 2010,
  "yearRangeMax": 2025
}
```

### Journalism investigation (central person, many aliases)
```json
"principal": {
  "name": "John Smith",
  "aliases": ["jsmith@company.com", "J. Smith", "johnsmith", "the CEO"],
  "hopFilterEnabled": true,
  "hopFilterDefault": 3
}
```

---

## What Claude Code will produce

After the migration, the file structure gains:

```
docnet/
├── CLAUDE.md                      ← Claude Code reads this
├── MIGRATION.md                   ← Implementation checklist
├── ARCHITECTURE.md                ← Design decisions
├── docnet.config.json             ← Your project config (you edit this)
├── docnet.config.example.json     ← Template with full documentation
├── config.ts                      ← NEW: Config loader
├── storage/
│   ├── IStorageAdapter.ts         ← NEW: Interface (seam for Variant E/B)
│   └── SqliteAdapter.ts           ← NEW: Current implementation
└── network-ui/src/
    └── config.ts                  ← NEW: Frontend config reader
```

Everything else is modified in-place per MIGRATION.md.

---

## Next steps after Variant A

When you're ready for **Variant E** (Hybrid export):

```
Read ARCHITECTURE.md section "Decision 6: Export Hook" and
MIGRATION.md Phase 7 "IStorageAdapter Abstraction".

Implement:
1. storage/SqlJsAdapter.ts – implements IStorageAdapter using sql.js
2. export/runExportHook.ts – bundles SQLite + config into .docnet zip
3. Update build.sh to also build a static-only bundle (no Express)
4. Update docnet.config.json: set export.enabled = true
```

When you're ready for **Variant B** (SaaS):

```
Read ARCHITECTURE.md section "Decision 7: What Variant B/C Adds".

Start with:
1. storage/PostgresAdapter.ts
2. Auth middleware (suggest: @lucia-auth/adapter-postgresql or Auth.js)
3. routes/projects.ts – project CRUD
4. routes/upload.ts – file upload → job queue
```
