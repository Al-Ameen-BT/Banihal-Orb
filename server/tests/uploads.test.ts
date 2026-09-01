import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sniffImageType, verifyUploads, UPLOAD_DIR } from '../src/modules/ticketing/uploads';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const GIF = Buffer.from('GIF89a__', 'latin1');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WEBPVP8L', 'latin1'),
]);
// What the old `mimetype.startsWith('image/')` filter waved through: a
// script-bearing SVG the browser labelled image/png.
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

// Write a file into UPLOAD_DIR and describe it the way multer would.
function staged(bytes: Buffer, mimetype: string): Express.Multer.File {
  const filename = `vitest-${Math.random().toString(36).slice(2, 10)}.png`;
  const full = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(full, bytes);
  return { filename, path: full, mimetype, originalname: 'x.png', size: bytes.length } as Express.Multer.File;
}

const run = (files: Express.Multer.File[]): Promise<unknown> =>
  new Promise((resolve) => verifyUploads({ files } as never, {} as never, resolve as never));

describe('attachment upload verification', () => {
  it('identifies each accepted format by its magic bytes', () => {
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(WEBP)).toBe('image/webp');
  });

  it('rejects bytes that are not one of the four formats', () => {
    expect(sniffImageType(SVG)).toBeNull();
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
    expect(sniffImageType(Buffer.from('MZ', 'latin1'))).toBeNull(); // PE executable
  });

  it('passes a real image through and records the sniffed type', async () => {
    const file = staged(PNG, 'image/png');
    expect(await run([file])).toBeUndefined(); // next() with no error
    expect(file.mimetype).toBe('image/png');
    expect(fs.existsSync(file.path)).toBe(true);
    fs.unlinkSync(file.path);
  });

  it('overwrites a lying Content-Type with the truth from the bytes', async () => {
    // Declared JPEG, actually a PNG: stored metadata must follow the bytes, since
    // downloadAttachment echoes that value back as the response Content-Type.
    const file = staged(PNG, 'image/jpeg');
    await run([file]);
    expect(file.mimetype).toBe('image/png');
    fs.unlinkSync(file.path);
  });

  it('rejects an SVG mislabelled image/png and deletes it', async () => {
    const file = staged(SVG, 'image/png');
    const err = await run([file]) as { status?: number; code?: string };
    expect(err?.status).toBe(400);
    expect(err?.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(fs.existsSync(file.path)).toBe(false);
  });

  it('rejects the whole batch, leaving no half-accepted files on disk', async () => {
    const good = staged(PNG, 'image/png');
    const bad = staged(SVG, 'image/png');
    expect((await run([good, bad]) as { status?: number })?.status).toBe(400);
    expect(fs.existsSync(good.path)).toBe(false);
    expect(fs.existsSync(bad.path)).toBe(false);
  });
});
