# Phase 2 – Upload & Job Queue
## PDF Upload · Background Processing · Progress Tracking

Prerequisite: Phase 1 complete and verified.

**Deliverable:** Reporters can upload PDFs (single or batch) to a project via
drag-and-drop. The system queues the analysis, processes it in the background
via Claude API, and shows live progress. When done, the graph populates.

---

## Step 2.1 — Install Dependencies

```bash
npm install multer @types/multer
# Multer handles multipart/form-data file uploads
```

---

## Step 2.2 — File Upload Middleware

Create `upload/fileHandler.ts`:

```typescript
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

// Ensure upload directories exist
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export function projectUploadDir(projectId: string): string {
  const dir = path.join(UPLOAD_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sanitizeFilename(original: string): string {
  // Remove path traversal, keep only safe characters
  return path.basename(original).replace(/[^a-zA-Z0-9._-]/g, '_');
}

export const uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = projectUploadDir(req.params.projectId);
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const safe = sanitizeFilename(file.originalname);
      const unique = `${Date.now()}-${uuid().slice(0, 8)}-${safe}`;
      cb(null, unique);
    }
  }),
  limits: {
    fileSize: 50 * 1024 * 1024,  // 50 MB per file
    files: 20                      // max 20 files per request
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.md', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${ext}. Allowed: ${allowed.join(', ')}`));
    }
  }
});
```

---

## Step 2.3 — Job Queue

Create `worker/queue.ts`:

```typescript
import { pool } from '../db/pool';

export interface Job {
  id: string;
  projectId: string;
  type: 'pdf' | 'web';
  status: 'pending' | 'running' | 'done' | 'error';
  payload: Record<string, any>;
  progress: number;
  result: any;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export const queue = {
  async enqueue(params: { projectId: string; type: 'pdf' | 'web'; payload: object }): Promise<Job> {
    const { rows } = await pool.query(
      `INSERT INTO jobs (project_id, type, payload)
       VALUES ($1, $2, $3) RETURNING *`,
      [params.projectId, params.type, JSON.stringify(params.payload)]
    );
    return rows[0];
  },

  // Atomically claim one pending job (no race conditions)
  async claim(): Promise<Job | null> {
    const { rows } = await pool.query(`
      UPDATE jobs SET status = 'running', started_at = NOW()
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);
    return rows[0] || null;
  },

  async setProgress(jobId: string, progress: number): Promise<void> {
    await pool.query(
      'UPDATE jobs SET progress = $1 WHERE id = $2',
      [Math.min(100, Math.max(0, progress)), jobId]
    );
  },

  async setDone(jobId: string, result?: object): Promise<void> {
    await pool.query(
      `UPDATE jobs SET status = 'done', progress = 100,
       result = $1, completed_at = NOW() WHERE id = $2`,
      [result ? JSON.stringify(result) : null, jobId]
    );
  },

  async setError(jobId: string, error: string): Promise<void> {
    await pool.query(
      `UPDATE jobs SET status = 'error', error = $1, completed_at = NOW() WHERE id = $2`,
      [error, jobId]
    );
  },

  async getJob(jobId: string): Promise<Job | null> {
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId]);
    return rows[0] || null;
  },

  async listForProject(projectId: string, limit = 20): Promise<Job[]> {
    const { rows } = await pool.query(
      `SELECT * FROM jobs WHERE project_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [projectId, limit]
    );
    return rows;
  }
};
```

---

## Step 2.4 — Upload Route

Create `routes/upload.ts`:

```typescript
import { Router } from 'express';
import { authMiddleware } from '../auth/middleware';
import { requireProjectOwner } from './projects';
import { uploadMiddleware } from '../upload/fileHandler';
import { queue } from '../worker/queue';

const router = Router({ mergeParams: true });

// POST /api/projects/:projectId/upload
// Accepts multipart/form-data with files[] field
router.post('/',
  authMiddleware,
  async (req, res, next) => {
    // Verify project ownership before accepting upload
    const owned = await requireProjectOwner(req.params.projectId, req.user!.userId);
    if (!owned) return res.status(404).json({ error: 'Project not found' });
    next();
  },
  uploadMiddleware.array('files', 20),
  async (req, res) => {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Enqueue one job per file
    const jobs = await Promise.all(files.map(file =>
      queue.enqueue({
        projectId: req.params.projectId,
        type: 'pdf',
        payload: {
          filePath: file.path,
          originalName: file.originalname,
          mimeType: file.mimetype
        }
      })
    ));

    res.json({
      queued: jobs.length,
      jobs: jobs.map(j => ({ id: j.id, filename: j.payload.originalName, status: j.status }))
    });
  }
);

export default router;
```

---

## Step 2.5 — Jobs Route

Create `routes/jobs.ts`:

```typescript
import { Router } from 'express';
import { authMiddleware } from '../auth/middleware';
import { requireProjectOwner } from './projects';
import { queue } from '../worker/queue';

const router = Router({ mergeParams: true });

// GET /api/projects/:projectId/jobs
router.get('/',
  authMiddleware,
  async (req, res) => {
    const owned = await requireProjectOwner(req.params.projectId, req.user!.userId);
    if (!owned) return res.status(404).json({ error: 'Project not found' });

    const jobs = await queue.listForProject(req.params.projectId);
    res.json(jobs);
  }
);

// GET /api/jobs/:jobId  (global — for polling without knowing projectId)
const globalRouter = Router();
globalRouter.get('/:jobId', authMiddleware, async (req, res) => {
  const job = await queue.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Verify user owns the project this job belongs to
  const owned = await requireProjectOwner(job.projectId, req.user!.userId);
  if (!owned) return res.status(404).json({ error: 'Job not found' });

  res.json(job);
});

export { globalRouter as jobsRouter };
export default router;
```

---

## Step 2.6 — Analysis Worker

Create `worker/pipeline.ts` — the shared analysis logic extracted from
`analysis_pipeline/analyze_documents.ts`. This is the heavy lifting:

```typescript
import Anthropic from '@anthropic-ai/sdk';
import { PostgresAdapter } from '../storage/PostgresAdapter';
import { pool } from '../db/pool';
import { config } from '../config';

const client = new Anthropic();

export async function analyzeText(params: {
  projectId: string;
  docId: string;
  filePath: string;
  content: string;
  originalName: string;
}): Promise<{ triplesCount: number; cost: number }> {
  const adapter = new PostgresAdapter(pool, params.projectId);

  // Check if already analyzed
  const existing = await adapter.getDocument(params.docId);
  if (existing) return { triplesCount: 0, cost: 0 };

  // Call Claude API (same prompt as analyze_documents.ts)
  const message = await client.messages.create({
    model: config.analysis.model,
    max_tokens: 16000,
    messages: [{ role: 'user', content: buildPrompt(params.content, params.docId) }]
  });

  // Parse response and save to database
  const analysis = parseAnalysisResponse(message.content[0]);
  await adapter.saveDocument({
    docId: params.docId,
    filePath: params.filePath,
    analysis,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens
  });
  await adapter.saveTriples(params.docId, analysis.rdf_triples);

  const cost = calculateCost(message.usage);
  return { triplesCount: analysis.rdf_triples.length, cost };
}
```

The `buildPrompt` function is directly copied from `analyze_documents.ts`
but reads `config.principal` for the principal context section.

Create `worker/processors/pdf.ts`:

```typescript
import { Job } from '../queue';
import { queue } from '../queue';
import { analyzeText } from '../pipeline';
import { extractTextFromPdf } from './pdfExtract';
import path from 'path';

export async function processPdfJob(job: Job): Promise<void> {
  const { filePath, originalName } = job.payload;

  await queue.setProgress(job.id, 5);

  // Extract text from PDF
  const text = await extractTextFromPdf(filePath);
  await queue.setProgress(job.id, 20);

  // Analyze with Claude
  const docId = path.basename(filePath, path.extname(filePath));
  const result = await analyzeText({
    projectId: job.projectId,
    docId,
    filePath,
    content: text,
    originalName
  });

  await queue.setProgress(job.id, 100);
  await queue.setDone(job.id, result);
}
```

Create `worker/processors/pdfExtract.ts` — uses `pdf-parse` or `pdfjs-dist`
to extract plain text from PDF files. For scanned PDFs (image-only),
fall back to an error message noting OCR is not available.

```bash
npm install pdf-parse @types/pdf-parse
```

---

## Step 2.7 — Worker Entry Point

Create `worker/index.ts` — this runs as a separate PM2 process:

```typescript
import { queue } from './queue';
import { processPdfJob } from './processors/pdf';
import { processWebJob } from './processors/web';  // Phase 3

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processJob(job: any) {
  switch (job.type) {
    case 'pdf': return processPdfJob(job);
    case 'web': return processWebJob(job);  // Phase 3
    default: throw new Error(`Unknown job type: ${job.type}`);
  }
}

async function runWorker() {
  console.log('Analysis worker started. Waiting for jobs...');

  while (true) {
    try {
      const job = await queue.claim();
      if (!job) {
        await sleep(2000);
        continue;
      }

      console.log(`Processing job ${job.id} (type: ${job.type}, project: ${job.projectId})`);

      try {
        await processJob(job);
        console.log(`Job ${job.id} completed`);
      } catch (err: any) {
        console.error(`Job ${job.id} failed:`, err.message);
        await queue.setError(job.id, err.message);
      }
    } catch (err) {
      console.error('Worker loop error:', err);
      await sleep(5000);
    }
  }
}

runWorker();
```

---

## Step 2.8 — Frontend: Upload UI

### Upload component (`network-ui/src/components/UploadZone.tsx`)

A drag-and-drop zone that accepts PDFs. When files are dropped:
1. POST to `/api/projects/:projectId/upload` with `FormData`
2. Receive array of job IDs
3. Start polling each job via `GET /api/jobs/:jobId` every 3 seconds
4. Show progress bar per file (0–100%)
5. When all jobs are `done`, call `onComplete()` to refresh the graph

Visual states:
- Idle: dashed border, "Drop PDFs here or click to browse"
- Dragging: solid blue border, highlighted
- Uploading: progress bars with filename + percentage
- Done: green checkmarks, "Analysis complete. Graph updated."
- Error: red row with error message, retry button

```tsx
// Polling hook: network-ui/src/hooks/useJobs.ts
export function useJobPolling(jobIds: string[], token: string, onAllDone: () => void) {
  const [statuses, setStatuses] = useState<Record<string, Job>>({});

  useEffect(() => {
    if (jobIds.length === 0) return;

    const poll = async () => {
      const results = await Promise.all(
        jobIds.map(id =>
          fetch(`/api/jobs/${id}`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.json())
        )
      );
      const map: Record<string, Job> = {};
      results.forEach(j => { map[j.id] = j; });
      setStatuses(map);

      const allDone = results.every(j => j.status === 'done' || j.status === 'error');
      if (allDone) onAllDone();
    };

    const interval = setInterval(poll, 3000);
    poll(); // immediate first poll
    return () => clearInterval(interval);
  }, [jobIds.join(',')]);

  return statuses;
}
```

### Integration in ProjectDetail.tsx

Add an `<UploadZone>` component above the graph. When `onComplete` fires,
re-fetch the graph data (call `loadData()` again). The graph should
automatically show the newly analyzed documents.

---

## Step 2.9 — Wire Up in api_server.ts

Add to `api_server.ts`:

```typescript
import uploadRoute from './routes/upload';
import projectJobsRoute from './routes/jobs';
import { jobsRouter } from './routes/jobs';

// Upload endpoint
app.use('/api/projects/:projectId/upload', uploadRoute);

// Job status endpoints
app.use('/api/projects/:projectId/jobs', projectJobsRoute);
app.use('/api/jobs', jobsRouter);
```

Also add to `package.json` scripts:
```json
"worker": "tsx worker/index.ts"
```

---

## Phase 2 Verification Checklist

- [ ] `npm install` includes `multer`, `pdf-parse`
- [ ] Upload directory created automatically when first file is uploaded
- [ ] `POST /api/projects/:id/upload` with a PDF returns `{ queued: 1, jobs: [...] }`
- [ ] `POST /api/projects/:id/upload` without auth returns 401
- [ ] `POST /api/projects/:id/upload` with another user's project returns 404
- [ ] `GET /api/jobs/:jobId` returns job status
- [ ] Worker process (`npx tsx worker/index.ts`) starts without errors
- [ ] Upload a real PDF → worker picks it up within 3 seconds → Claude analyzes it → job status becomes 'done'
- [ ] After job completes, `GET /api/projects/:id/stats` shows increased doc/triple count
- [ ] Browser: drag-and-drop a PDF onto UploadZone → progress bar appears → graph updates when done
- [ ] Large file (10+ MB PDF) does not time out the HTTP request
- [ ] Uploading 5 PDFs at once creates 5 separate jobs, all processed sequentially
- [ ] File type rejection: uploading a .exe returns a 400 error
