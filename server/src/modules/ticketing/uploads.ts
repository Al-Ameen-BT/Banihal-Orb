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

// Attachments are images only. Enforced HERE rather than per-route because both
// upload routes (ticket attachments + comment attachments) share this instance, so
// this is the single trust boundary a hand-rolled request has to pass.
const imagesOnly: multer.Options['fileFilter'] = (_req, file, cb) => {
  if (file.mimetype.startsWith('image/')) { cb(null, true); return; }
  cb(Object.assign(new Error('Only image files can be attached.'), { status: 400, code: 'UNSUPPORTED_FILE_TYPE' }));
};

// Up to 5 files, 10 MB each — matches the report's guest/comment upload caps.
export const upload = multer({ storage, fileFilter: imagesOnly, limits: { fileSize: 10 * 1024 * 1024, files: 5 } });
