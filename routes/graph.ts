import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authMiddleware } from '../auth/middleware.js';
import { requireProjectOwner } from './projects.js';
import { PostgresAdapter } from '../storage/PostgresAdapter.js';

const router = Router({ mergeParams: true });

// --- Input validation helpers ---

function validateLimit(limit: any): number {
  const parsed = parseInt(limit);
  if (isNaN(parsed) || parsed < 1) return 500;
  return Math.min(20000, Math.max(1, parsed));
}

function validateClusterIds(clusters: any): number[] {
  if (!clusters) return [];
  return String(clusters)
    .split(',')
    .map(Number)
    .filter(n => !isNaN(n) && n >= 0 && Number.isInteger(n))
    .slice(0, 50);
}

function validateCategories(categories: any): string[] {
  if (!categories) return [];
  return String(categories)
    .split(',')
    .map(c => c.trim())
    .filter(c => c.length > 0 && c.length < 100)
    .slice(0, 50);
}

function validateYearRange(yearMin: any, yearMax: any): [number, number] | null {
  if (!yearMin && !yearMax) return null;
  const min = parseInt(yearMin);
  const max = parseInt(yearMax);
  if (isNaN(min) || isNaN(max)) return null;
  if (min < 1900 || max > 2100 || min > max) return null;
  return [min, max];
}

function validateKeywords(keywords: any): string[] {
  if (!keywords) return [];
  return String(keywords)
    .split(',')
    .map(k => k.trim().toLowerCase())
    .filter(k => k.length > 0 && k.length < 100)
    .slice(0, 20);
}

function validateMaxHops(maxHops: any): number | null {
  if (!maxHops) return null;
  if (maxHops === 'any') return null;
  const parsed = parseInt(maxHops);
  if (isNaN(parsed) || parsed < 1 || parsed > 10) return null;
  return parsed;
}

// All graph routes require auth and project ownership
router.use(authMiddleware);

// Middleware: verify project ownership and attach adapter
router.use(async (req, res, next) => {
  const projectId = req.params.projectId;
  if (!projectId) return res.status(400).json({ error: 'Project ID required' });

  const owned = await requireProjectOwner(projectId, req.user!.userId);
  if (!owned) return res.status(404).json({ error: 'Project not found' });

  (req as any).adapter = new PostgresAdapter(pool, projectId);
  next();
});

router.get('/relationships', async (req, res) => {
  try {
    const adapter = (req as any).adapter as PostgresAdapter;
    const result = await adapter.getRelationships({
      limit: validateLimit(req.query.limit),
      clusterIds: validateClusterIds(req.query.clusters),
      categories: validateCategories(req.query.categories),
      yearRange: validateYearRange(req.query.yearMin, req.query.yearMax),
      includeUndated: req.query.includeUndated !== 'false',
      keywords: validateKeywords(req.query.keywords),
      maxHops: validateMaxHops(req.query.maxHops),
    });
    res.json(result);
  } catch (error) {
    console.error('Error in relationships:', error);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

router.get('/actor/:name/relationships', async (req, res) => {
  try {
    const { name } = req.params;
    if (!name || name.length > 200) {
      return res.status(400).json({ error: 'Invalid actor name' });
    }
    const adapter = (req as any).adapter as PostgresAdapter;
    const result = await adapter.getActorRelationships(name, {
      limit: 0,
      clusterIds: validateClusterIds(req.query.clusters),
      categories: validateCategories(req.query.categories),
      yearRange: validateYearRange(req.query.yearMin, req.query.yearMax),
      includeUndated: req.query.includeUndated !== 'false',
      keywords: validateKeywords(req.query.keywords),
      maxHops: validateMaxHops(req.query.maxHops),
    });
    res.json(result);
  } catch (error) {
    console.error('Error in actor relationships:', error);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const adapter = (req as any).adapter as PostgresAdapter;
    res.json(await adapter.getStats());
  } catch (error) {
    console.error('Error in stats:', error);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

router.get('/search', async (req, res) => {
  try {
    const query = req.query.q as string;
    if (!query) return res.json([]);
    const adapter = (req as any).adapter as PostgresAdapter;
    res.json(await adapter.searchActors(query));
  } catch (error) {
    console.error('Error in search:', error);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

router.get('/actor-counts', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 300;
    const adapter = (req as any).adapter as PostgresAdapter;
    res.json(await adapter.getActorCounts(limit));
  } catch (error) {
    console.error('Error in actor-counts:', error);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

router.get('/actor/:name/count', async (req, res) => {
  try {
    const adapter = (req as any).adapter as PostgresAdapter;
    res.json({ count: await adapter.getActorCount(req.params.name) });
  } catch (error) {
    console.error('Error in actor count:', error);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

router.get('/document/:docId', async (req, res) => {
  try {
    const adapter = (req as any).adapter as PostgresAdapter;
    const doc = await adapter.getDocument(req.params.docId);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json(doc);
  } catch (error) {
    console.error('Error in document:', error);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

router.get('/document/:docId/text', async (req, res) => {
  try {
    const { docId } = req.params;
    if (!docId || docId.length > 100 || /[<>:"|?*]/.test(docId)) {
      return res.status(400).json({ error: 'Invalid document ID' });
    }
    const adapter = (req as any).adapter as PostgresAdapter;
    const text = await adapter.getDocumentText(docId);
    if (text === null) return res.status(404).json({ error: 'Document text not available' });
    res.json({ text });
  } catch (error) {
    console.error('Error in document text:', error);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

router.get('/tag-clusters', async (req, res) => {
  try {
    const adapter = (req as any).adapter as PostgresAdapter;
    res.json(await adapter.getTagClusters());
  } catch (error) {
    console.error('Error in tag-clusters:', error);
    res.status(500).json({ error: 'An internal error occurred' });
  }
});

export default router;
