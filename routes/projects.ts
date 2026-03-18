import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authMiddleware } from '../auth/middleware.js';

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
