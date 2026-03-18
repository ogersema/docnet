import { Router } from 'express';
import { authMiddleware } from '../auth/middleware.js';
import { requireProjectOwner } from './projects.js';
import { queue } from '../worker/queue.js';
import { pool } from '../db/pool.js';

const router = Router({ mergeParams: true });

// POST /api/projects/:projectId/crawl
router.post('/',
  authMiddleware,
  async (req, res, next) => {
    const owned = await requireProjectOwner(req.params.projectId, req.user!.userId);
    if (!owned) return res.status(404).json({ error: 'Project not found' });
    next();
  },
  async (req, res) => {
    const { url, maxDepth = 0, domainOnly = true, maxPages = 50 } = req.body;

    // Validate URL
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: 'Only http and https URLs are supported' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    // Check for duplicate (already crawled or pending/running job with same URL)
    const { rows: existingSources } = await pool.query(
      'SELECT id FROM web_sources WHERE project_id = $1 AND url = $2',
      [req.params.projectId, url]
    );
    if (existingSources.length > 0) {
      return res.status(409).json({ error: 'This URL has already been crawled in this project' });
    }

    const { rows: pendingJobs } = await pool.query(
      `SELECT id FROM jobs WHERE project_id = $1 AND type = 'web'
       AND status IN ('pending', 'running')
       AND payload->>'url' = $2`,
      [req.params.projectId, url]
    );
    if (pendingJobs.length > 0) {
      return res.status(409).json({ error: 'A crawl job for this URL is already in progress' });
    }

    // Enqueue crawl job
    const job = await queue.enqueue({
      projectId: req.params.projectId,
      type: 'web',
      payload: {
        url,
        maxDepth: Math.min(3, Math.max(0, parseInt(maxDepth) || 0)),
        domainOnly: Boolean(domainOnly),
        maxPages: Math.min(200, Math.max(1, parseInt(maxPages) || 50))
      }
    });

    res.json({ jobId: job.id, url, maxDepth, maxPages });
  }
);

// GET /api/projects/:projectId/crawl/sources
router.get('/sources',
  authMiddleware,
  async (req, res, next) => {
    const owned = await requireProjectOwner(req.params.projectId, req.user!.userId);
    if (!owned) return res.status(404).json({ error: 'Project not found' });
    next();
  },
  async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, url, title, doc_count, crawled_at
       FROM web_sources WHERE project_id = $1
       ORDER BY crawled_at DESC`,
      [req.params.projectId]
    );
    res.json(rows);
  }
);

export default router;
