import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { env } from '../../config/env';

// Local-disk attachment storage (report parity). The directory is configurable
// via UPLOAD_DIR; persist it in production (the systemd deploy rebuilds the tree).
export const UPLOAD_DIR = path.resolve(process.cwd(), env.UPLOAD_DIR);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12);
    cb(null, `${crypto.randomBytes(10).toString('hex')}${ext}`);
  },
});

// Up to 5 files, 10 MB each — matches the report's guest/comment upload caps.
export const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024, files: 5 } });
