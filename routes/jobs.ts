import { Router } from 'express';
import { authMiddleware } from '../auth/middleware.js';
import { requireProjectOwner } from './projects.js';
import { queue } from '../worker/queue.js';

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

  const owned = await requireProjectOwner(job.project_id, req.user!.userId);
  if (!owned) return res.status(404).json({ error: 'Job not found' });

  res.json(job);
});

export { globalRouter as jobsRouter };
export default router;
