import { $, ACT_HEADERS, store, toast } from './core.js';
import { decodeEntities } from './markdown.js';

// The optional talking avatar: reads the open session's new replies aloud, all on this Mac.
// The face is a mouth bank built once, offline (avatar/bank_build.py): a head-motion loop plus, for each
// loop frame, mouths of several openings. While speech plays, every frame shows the mouth whose opening
// is closest to the sound's loudness at that moment. Speech is local Kokoro (avatar/tts_worker.py).
export const av = { man: null, on: store.get('avatarVoice', false), queue: [], gen: 0, busy: false, ctx: null, src: null, env: null, start: 0, pass: -1, drawn: -1, lastReply: '', loaded: false, t0: performance.now() };

async function avatarInit() {
  const r = await fetch('/api/avatar/manifest').catch(() => null);
  if (!r?.ok) return;
  av.man = await r.json();
  $('av-who').textContent = av.man.name || 'Avatar';
  $('av-label').textContent = av.man.label || '';
  $('avatar').hidden = false;
  avatarControls();
}

// `v` is the bank's version, so images cached from an older bank are never used with this manifest.
const avatarUrl = (name) => `/api/avatar/${name}.jpg?v=${av.man.version}`;

// Until the voice is used, the face is one still frame: the full loop (hundreds of frames) loads on first use.
export function avatarPoster() {
  if (av.loaded || !av.man) return;
  const im = Object.assign(new Image(), { src: avatarUrl('base/0000') });
  im.onload = () => { if (!av.loaded) $('av-canvas').getContext('2d').drawImage(im, 0, 0); };
}

export function avatarLoad() {
  if (av.loaded || !av.man) return;
  av.loaded = true;
  const img = (src) => Object.assign(new Image(), { src });
  av.base = Array.from({ length: av.man.frames }, (_, i) => img(avatarUrl(`base/${String(i).padStart(4, '0')}`)));
  av.sheets = Array.from({ length: av.man.passes }, (_, k) => img(avatarUrl(`pass${k}`)));
  av.ranked = av.man.open.flat().sort((x, y) => x - y);
  const [cw, ch] = av.man.cell;
  av.cell = Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  av.mask = Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  // A feathered edge, so the mouth cell melts into the frame around it.
  const m = av.mask.getContext('2d'), a = m.createImageData(cw, ch), f = Math.max(4, Math.round(Math.min(cw, ch) * 0.16));
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const k = Math.min(1, x / f, y / f, (cw - 1 - x) / f, (ch - 1 - y) / f);
    a.data[(y * cw + x) * 4 + 3] = Math.round(255 * k * k * (3 - 2 * k));
  }
  m.putImageData(a, 0, 0);
  requestAnimationFrame(avatarDraw);
}

function avatarTarget() {
  if (!av.src || !av.env) return 0;
  const e = av.env[Math.floor((av.ctx.currentTime - av.start + 0.04) * av.man.fps)] ?? 0;
  return e < 0.12 ? 0 : Math.min(1, (e - 0.12) / 0.7);
}

function avatarDraw(now) {
  requestAnimationFrame(avatarDraw);
  // Moving only while the drawer is open and the voice is on or speaking; otherwise the face rests.
  if (!$('drawer').classList.contains('open') || !(av.on || av.busy || av.queue.length || av.pass >= 0)) return;
  const m = av.man, n = m.frames, period = Math.max(1, 2 * n - 2);
  const k = Math.floor((now - av.t0) / 1000 * m.fps) % period;
  const f = k < n ? k : period - k;          // the loop plays forward, then back
  if (f === av.drawn) return;
  const base = av.base[f];
  if (!base.complete || !base.naturalWidth) return;
  av.drawn = f;
  const g = $('av-canvas').getContext('2d');
  g.drawImage(base, 0, 0);
  // While sound plays, always a talking mouth: loudness picks by rank among the bank's openings
  // (the resting smile shows teeth, so measured openings do not start at zero).
  const loud = avatarTarget();
  let best = -1;
  if (loud > 0) {
    const want = av.ranked[Math.round(loud * (av.ranked.length - 1))];
    const miss = (p) => (p < 0 ? Infinity : Math.abs(m.open[p][f] - want));
    for (let p = 0; p < m.passes; p++) if (miss(p) < miss(best)) best = p;
    if (av.pass !== best && miss(av.pass) < miss(best) + 0.08) best = av.pass;  // no flicker between near-equal mouths
  }
  av.pass = best;
  const sheet = av.sheets[best];
  if (best < 0 || !sheet.complete) return;
  const [cw, ch] = m.cell, c = av.cell.getContext('2d');
  c.globalCompositeOperation = 'copy';
  c.drawImage(sheet, (f % m.cols) * cw, Math.floor(f / m.cols) * ch, cw, ch, 0, 0, cw, ch);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(av.mask, 0, 0);
  g.drawImage(av.cell, m.pos[f][0], m.pos[f][1]);
}

// What is worth hearing in a reply: prose, not code, tables or URLs. Long replies are cut short.
function speakable(text) {
  let t = decodeEntities(String(text))
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s*\|.*$/gm, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|~~|\*)(\S[^*~\n]*?)\1/g, '$2')
    .replace(/(^|[^\w])(__?)(\S[^_\n]*?)\2(?!\w)/g, '$1$3')   // _emphasis_, but not snake_case_names
    .replace(/\s+/g, ' ').trim();
  if (t.length > 900) t = t.slice(0, Math.max(t.lastIndexOf('. ', 900), 400) + 1) + ' The rest is in the text.';
  const chunks = [];
  for (const s of t.split(/(?<=[.!?])\s+/)) {
    // the first sentence alone, so the voice starts quickly; later ones in chunks of about 220 characters
    if (chunks.length > 1 && (chunks.at(-1) + ' ' + s).length < 220) chunks[chunks.length - 1] += ' ' + s;
    else if (s.trim()) chunks.push(s.trim());
  }
  return chunks;
}

function audioReady() {
  av.ctx ??= new AudioContext();
  return av.ctx.resume();
}

function envelope(buf) {
  const d = buf.getChannelData(0), hop = Math.round(buf.sampleRate / av.man.fps), rms = [];
  for (let i = 0; i < d.length; i += hop) {
    let s = 0; const end = Math.min(d.length, i + hop);
    for (let j = i; j < end; j++) s += d[j] * d[j];
    rms.push(Math.sqrt(s / Math.max(1, end - i)));
  }
  const peak = [...rms].sort((x, y) => x - y)[Math.floor(rms.length * 0.95)] || 1;
  return rms.map((v, i) => Math.min(1, ((rms[i - 1] ?? v) + 2 * v + (rms[i + 1] ?? v)) / 4 / peak));
}

function avatarFetch(item) {
  item.audio ??= fetch('/api/avatar/speak', { method: 'POST', headers: { 'Content-Type': 'application/json', ...ACT_HEADERS }, body: JSON.stringify({ text: item.text }) })
    .then((r) => (r.ok ? r.arrayBuffer() : r.text().then((m) => Promise.reject(new Error(m)))))
    .then((b) => av.ctx.decodeAudioData(b));
  return item.audio;
}

export function avatarSay(text) {
  const parts = speakable(text);
  if (!parts.length || !av.man) return;
  av.queue.push(...parts.map((t) => ({ text: t })));
  avatarPump();
}

async function avatarPump() {
  avatarState();
  if (av.busy || !av.queue.length) return;
  av.busy = true;
  const gen = av.gen;
  try {
    await audioReady();
    const buf = await avatarFetch(av.queue[0]);
    if (av.queue[1]) avatarFetch(av.queue[1]).catch(() => {});   // the next part is voiced while this one plays
    if (gen !== av.gen) return;
    av.env = envelope(buf);
    const src = av.ctx.createBufferSource();
    src.buffer = buf; src.connect(av.ctx.destination);
    av.src = src; av.start = av.ctx.currentTime + 0.03; src.start(av.start);
    avatarState();
    await new Promise((r) => { src.onended = r; });
  } catch (e) {
    if (gen === av.gen) toast(`${av.man.name || 'The avatar'} could not speak: ${e.message || e}`);
  } finally {
    if (gen === av.gen) { av.queue.shift(); av.src = null; av.env = null; av.busy = false; avatarPump(); }
  }
}

export function avatarStop() {
  av.gen++; av.queue = [];
  try { av.src?.stop(); } catch { /* already ended */ }
  av.src = null; av.env = null; av.busy = false;
  if (av.man) avatarState();
}

function avatarState() {
  const speaking = av.busy || av.queue.length > 0;
  $('av-state').textContent = speaking ? (av.src ? 'speaking' : 'getting ready…') : av.on ? 'listening for new replies' : '';
  $('av-state').classList.toggle('on', speaking);
  $('av-stop').hidden = !speaking;
}

function avatarControls() {
  $('av-voice').textContent = `Voice: ${av.on ? 'on' : 'off'}`;
  $('av-voice').title = av.on ? 'Stop reading new replies aloud' : 'Read new replies in this session aloud as they arrive';
  avatarState();
}

$('av-voice').onclick = () => {
  av.on = !av.on; store.set('avatarVoice', av.on);
  if (av.on) { audioReady(); avatarLoad(); fetch('/api/avatar/warm', { method: 'POST', headers: { ...ACT_HEADERS } }).catch(() => {}); } else avatarStop();
  avatarControls();
};
$('av-last').onclick = () => {
  audioReady(); avatarLoad(); avatarStop();
  if (av.lastReply) avatarSay(av.lastReply); else toast('No reply in this session yet.');
};
$('av-stop').onclick = avatarStop;
avatarInit();

// Click any picture to see it full size.
document.addEventListener('click', (e) => {
  const im = e.target.closest('img.thumb, img.mdimg');
  if (im && !e.target.closest('.mde-att')) { $('lightbox').querySelector('img').src = im.src; $('lightbox').hidden = false; return; }
  if (e.target.closest('#lightbox')) $('lightbox').hidden = true;
});
