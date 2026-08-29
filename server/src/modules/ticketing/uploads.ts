import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from '../../config/env';

// Local-disk attachment storage. Nothing in here is web-served: every read goes
// through downloadAttachment's access check, so this is private data, not a
// document root. 0700 keeps it that way if UPLOAD_DIR is ever pointed somewhere
// shared. NOTE: persist this path in production (the systemd deploy rebuilds the
// tree) and keep it OUT of the repo — see .gitignore.
export const UPLOAD_DIR = path.resolve(process.cwd(), env.UPLOAD_DIR);
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(UPLOAD_DIR, 0o700); // mkdir's `mode` is ignored when the dir already exists

// The only types we store, and the extension each gets on disk. The browser's
// declared Content-Type only picks the candidate — verifyUploads below decides
// whether it was telling the truth.
//
// image/svg+xml is deliberately absent: an SVG is a script-bearing document, and
// these bytes are handed back from the app's own origin. The old
// `mimetype.startsWith('image/')` filter admitted it.
const ALLOWED_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** Types downloadAttachment may echo back as-is. Anything else is served opaque. */
export const SERVEABLE_TYPES = new Set(Object.keys(ALLOWED_TYPES));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  // The stored name is random and carries NO part of file.originalname — that
  // string is attacker-controlled, and it used to supply the on-disk extension
  // (`.php`, `.svg`, `.html` all rode straight through). The extension here comes
  // from the allow-list and is advisory only; the DB's mimeType is authoritative.
  filename: (_req, file, cb) =>
    cb(null, `${crypto.randomBytes(16).toString('hex')}${ALLOWED_TYPES[file.mimetype] ?? ''}`),
});

const imagesOnly: multer.Options['fileFilter'] = (_req, file, cb) => {
  if (Object.hasOwn(ALLOWED_TYPES, file.mimetype)) { cb(null, true); return; }
  cb(Object.assign(new Error('Only PNG, JPEG, GIF or WebP images can be attached.'),
    { status: 400, code: 'UNSUPPORTED_FILE_TYPE' }));
};

// Up to 5 files, 10 MB each — matches the report's guest/comment upload caps.
const receive = multer({ storage, fileFilter: imagesOnly, limits: { fileSize: 10 * 1024 * 1024, files: 5 } });

/**
 * Magic-byte sniff of a file header. Returns the real media type, or null when
 * the bytes are not one of the four formats we accept.
 */
export function sniffImageType(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF'
      && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Second half of the trust boundary. multer's fileFilter can only check the
 * Content-Type the *client* wrote into the multipart part, so an HTML or SVG
 * payload labelled `image/png` passes it. This reads what actually landed on
 * disk, rejects the whole request if any file lies, and rewrites `mimetype` to
 * the sniffed truth so the value persisted (and later echoed on download) is one
 * we verified rather than one the uploader chose.
 */
export async function verifyUploads(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) { next(); return; }
  try {
    for (const file of files) {
      const head = Buffer.alloc(12);
      const handle = await fs.promises.open(file.path, 'r');
      try { await handle.read(head, 0, 12, 0); } finally { await handle.close(); }

      const actual = sniffImageType(head);
      if (!actual) {
        throw Object.assign(new Error('That file is not a valid PNG, JPEG, GIF or WebP image.'),
          { status: 400, code: 'UNSUPPORTED_FILE_TYPE' });
      }
      file.mimetype = actual;
    }
    next();
  } catch (err) {
    // Reject as a unit: a batch is all-or-nothing, so never leave the accepted
    // half of a rejected upload sitting on disk.
    await Promise.all(files.map((f) => fs.promises.unlink(f.path).catch(() => {})));
    next(err);
  }
}

/** Mount this, not `receive`, so no route can accept files without the sniff. */
export const upload = {
  array: (field: string, max: number) => [receive.array(field, max), verifyUploads],
};
