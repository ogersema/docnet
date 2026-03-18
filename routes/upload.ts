import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { authMiddleware } from '../auth/middleware.js';
import { requireProjectOwner } from './projects.js';
import { uploadMiddleware } from '../upload/fileHandler.js';
import { queue } from '../worker/queue.js';

const router = Router({ mergeParams: true });

// POST /api/projects/:projectId/upload
router.post('/',
  authMiddleware,
  async (req, res, next) => {
    const owned = await requireProjectOwner(req.params.projectId, req.user!.userId);
    if (!owned) return res.status(404).json({ error: 'Project not found' });
    next();
  },
  (req: Request, res: Response, next: NextFunction) => {
    uploadMiddleware.array('files', 20)(req, res, (err: any) => {
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ error: err.message });
      }
      if (err) {
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

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
