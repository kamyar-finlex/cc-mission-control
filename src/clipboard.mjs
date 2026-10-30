// Saving and restoring the whole macOS clipboard (every item, every type: text, images, files),
// so sending a reply through it gives back exactly what was there.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.mjs';

const MAX_BYTES = 64 * 1024 * 1024; // larger clipboards fall back to their text

const jxa = (script, args = []) => new Promise((resolve) => {
  execFile('osascript', ['-l', 'JavaScript', '-e', script, ...args], { timeout: 20000, maxBuffer: MAX_BYTES * 2 }, (err, stdout) =>
    resolve(err ? null : String(stdout).trim()));
});

const board = `ObjC.import('AppKit');
const pb = name ? $.NSPasteboard.pasteboardWithName(name) : $.NSPasteboard.generalPasteboard;`;

// { items: [{ type: base64 }], count } where count is the clipboard's change counter; null if unavailable.
export async function saveClipboard(name = '') {
  if (process.platform !== 'darwin') return null;
  const out = await jxa(`function run(argv) {
    const name = argv[0]; ${board}
    const items = []; let size = 0;
    const list = pb.pasteboardItems;
    for (let i = 0; i < list.count; i++) {
      const it = list.objectAtIndex(i), types = it.types, entry = {};
      for (let j = 0; j < types.count; j++) {
        const t = ObjC.unwrap(types.objectAtIndex(j));
        const d = it.dataForType(t);
        if (!d || d.isNil()) continue;
        size += d.length;
        if (size > ${MAX_BYTES}) return JSON.stringify({ tooBig: true });
        entry[t] = ObjC.unwrap(d.base64EncodedStringWithOptions(0));
      }
      items.push(entry);
    }
    return JSON.stringify({ items, count: pb.changeCount });
  }`, [name]);
  try { const r = JSON.parse(out); return r.tooBig ? null : r; } catch { return null; }
}

export async function clipboardCount(name = '') {
  if (process.platform !== 'darwin') return null;
  const out = await jxa(`function run(argv) { const name = argv[0]; ${board} return String(pb.changeCount); }`, [name]);
  return out === null ? null : Number(out);
}

// Puts a saved clipboard back, but only if nothing new was copied since `expectCount` (pass null to
// skip that check). The saved data goes through an owner-only file that is removed right after.
export async function restoreClipboard(saved, { name = '', expectCount = null } = {}) {
  if (!saved || process.platform !== 'darwin') return false;
  if (expectCount !== null && (await clipboardCount(name)) !== expectCount) return false;
  const file = path.join(DATA_DIR, `clipboard-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(saved.items), { mode: 0o600 });
    const out = await jxa(`function run(argv) {
      const name = argv[0]; ${board}
      const text = $.NSString.stringWithContentsOfFileEncodingError(argv[1], $.NSUTF8StringEncoding, null);
      const items = JSON.parse(ObjC.unwrap(text));
      const objs = $.NSMutableArray.alloc.init;
      for (const entry of items) {
        const it = $.NSPasteboardItem.alloc.init;
        for (const t of Object.keys(entry)) it.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(entry[t], 0), t);
        objs.addObject(it);
      }
      pb.clearContents;
      return items.length ? String(pb.writeObjects(objs)) : 'true';
    }`, [name, file]);
    return out === 'true';
  } finally { fs.rmSync(file, { force: true }); }
}
