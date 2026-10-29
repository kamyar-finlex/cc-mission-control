import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, IMAGE_TYPES } from './config.mjs';


// Images pasted or dropped into the editor, saved where Claude Code can open them by path.
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
// A plain file name inside ATTACH_DIR: no separators, and never "." or "..".
export const attachmentPath = (name) => (typeof name === 'string' && /^[\w-][\w.-]{0,99}$/.test(name) ? path.join(ATTACH_DIR, name) : undefined);
export async function saveAttachment(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return { ok: false, out: 'Only PNG, JPEG, GIF or WebP images can be attached.' };
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10 * 1024 * 1024) return { ok: false, out: 'Images up to 10 MB only.' };
  await fsp.mkdir(ATTACH_DIR, { recursive: true });
  const name = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(5).toString('hex')}.${IMAGE_TYPES[m[1]]}`;
  await fsp.writeFile(path.join(ATTACH_DIR, name), buf);
  return { ok: true, name, path: path.join(ATTACH_DIR, name), url: `/api/attachments/${name}` };
}
