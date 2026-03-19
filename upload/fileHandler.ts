import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuid } from 'uuid';

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export function projectUploadDir(projectId: string): string {
  const dir = path.join(UPLOAD_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function sanitizeFilename(original: string): string {
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
    fileSize: 50 * 1024 * 1024,
    files: 20
  },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.md', '.docx', '.csv', '.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${ext}. Allowed: ${allowed.join(', ')}`));
    }
  }
});
