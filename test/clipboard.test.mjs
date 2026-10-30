// Saving and restoring the clipboard, on a private named pasteboard so the real one is never touched.
// macOS only (it drives NSPasteboard through osascript).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.CCMC_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccmc-clip-'));
const { saveClipboard, restoreClipboard, clipboardCount } = await import('../src/clipboard.mjs');
const NAME = `ccmc-test-${process.pid}`;
const mac = process.platform === 'darwin';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Puts items on the named pasteboard: [{ type: base64 }].
const put = (items) => execFileSync('osascript', ['-l', 'JavaScript', '-e', `function run(argv) {
  ObjC.import('AppKit');
  const pb = $.NSPasteboard.pasteboardWithName(argv[0]);
  const objs = $.NSMutableArray.alloc.init;
  for (const entry of JSON.parse(argv[1])) {
    const it = $.NSPasteboardItem.alloc.init;
    for (const t of Object.keys(entry)) it.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions(entry[t], 0), t);
    objs.addObject(it);
  }
  pb.clearContents; pb.writeObjects(objs); return 'ok';
}`, NAME, JSON.stringify(items)]);
const b64 = (s) => Buffer.from(s).toString('base64');

test('the whole clipboard comes back: text, an image and a custom type, across two items', { skip: !mac && 'macOS only' }, async () => {
  const original = [{ 'public.utf8-plain-text': b64('caption'), 'public.png': PNG }, { 'com.example.custom': b64('{"x":1}') }];
  put(original);
  const saved = await saveClipboard(NAME);
  assert.deepEqual(saved.items, original);
  put([{ 'public.utf8-plain-text': b64('the reply that was pasted') }]);
  assert.equal(await restoreClipboard(saved, { name: NAME }), true);
  assert.deepEqual((await saveClipboard(NAME)).items, original);
  assert.deepEqual(fs.readdirSync(process.env.CCMC_DATA_DIR).filter((f) => f.startsWith('clipboard-')), [], 'no saved copy left on disk');
});

test('a password manager\'s clipboard is neither saved nor put back', { skip: !mac && 'macOS only' }, async () => {
  put([{ 'public.utf8-plain-text': b64('hunter2'), 'org.nspasteboard.ConcealedType': b64('') }]);
  const saved = await saveClipboard(NAME);
  assert.deepEqual(saved, { sensitive: true }, 'the password never leaves the pasteboard');
  put([{ 'public.utf8-plain-text': b64('the reply') }]);
  assert.equal(await restoreClipboard(saved, { name: NAME }), false);
  assert.deepEqual((await saveClipboard(NAME)).items, [{ 'public.utf8-plain-text': b64('the reply') }]);
});

test('nothing is restored over something copied in the meantime', { skip: !mac && 'macOS only' }, async () => {
  put([{ 'public.utf8-plain-text': b64('before') }]);
  const saved = await saveClipboard(NAME);
  put([{ 'public.utf8-plain-text': b64('the reply') }]);
  const ours = await clipboardCount(NAME);
  put([{ 'public.utf8-plain-text': b64('copied by you just now') }]);
  assert.equal(await restoreClipboard(saved, { name: NAME, expectCount: ours }), false);
  assert.deepEqual((await saveClipboard(NAME)).items, [{ 'public.utf8-plain-text': b64('copied by you just now') }]);
});

test.after(() => {
  if (mac) execFileSync('osascript', ['-l', 'JavaScript', '-e', `function run(argv) { ObjC.import('AppKit'); $.NSPasteboard.pasteboardWithName(argv[0]).releaseGlobally; return 'ok'; }`, NAME]);
});
