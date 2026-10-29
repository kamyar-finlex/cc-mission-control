import fsp from 'node:fs/promises';
import { appFiles, appMeta } from './app-meta.mjs';
import { pipeTo, run, runOsa, sleep } from './proc.mjs';
import { refreshTranscript, transcripts } from './transcript.mjs';

// Sending a reply to a Claude app session (opt-in, macOS automation).
// The app has no input API, so this does what you would do: open the session,
// paste, press Enter. Every step is checked; on any doubt it stops before Enter.

const frontApp = async () => (await runOsa('tell application "System Events" to get name of first application process whose frontmost is true')).out;

// Accessibility (to read the focused box and press keys) and Automation (to talk to System Events).
export async function automationStatus() {
  if (process.platform !== 'darwin') return { ok: false, out: 'Send to agent needs macOS.' };
  // "UI elements enabled" is macOS's own answer to "may this process use Accessibility?".
  const r = await runOsa('tell application "System Events" to return (UI elements enabled as text) & "," & ((exists process "Claude") as text)');
  const node = process.execPath;
  if (!r.ok) {
    const why = /-1743|not allowed to send apple events|Not authorized/i.test(r.err) ? 'automation' : 'unknown';
    return { ok: false, why, node, out: r.err || 'Not allowed yet.' };
  }
  const [ax, running] = r.out.split(',');
  if (ax !== 'true') return { ok: false, why: 'accessibility', node, out: 'Accessibility is not allowed for node yet.' };
  if (running !== 'true') return { ok: false, why: 'app-closed', node, out: 'The Claude app is not running.' };
  return { ok: true, node, out: 'Automation is allowed.' };
}

// The Claude app shows its message box to accessibility only inside its own process, so the console
// can't read the box. It types the way you would and then confirms the result in the session's transcript.
const PASTE_AND_ENTER = `on run
  tell application "System Events"
    if (name of (first application process whose frontmost is true)) is not "Claude" then return "not-front"
    keystroke "v" using command down
  end tell
  delay 0.4
  tell application "System Events"
    if (name of (first application process whose frontmost is true)) is not "Claude" then return "not-front-after"
    key code 36
  end tell
  return "typed"
end run`;

// Waits for a new user message containing the reply in the session's transcript.
async function seenInTranscript(sid, fromSize, probe, ms = 8000) {
  const t = transcripts.get(sid);
  if (!t) return false;
  const want = probe.toLowerCase();
  for (const end = Date.now() + ms; Date.now() < end;) {
    await sleep(400);
    try {
      const st = await fsp.stat(t.file);
      if (st.size <= fromSize) continue;
      const fh = await fsp.open(t.file, 'r');
      const buf = Buffer.alloc(st.size - fromSize);
      await fh.read(buf, 0, buf.length, fromSize);
      await fh.close();
      for (const line of buf.toString('utf8').split('\n')) {
        const queued = line.includes('"type":"queue-operation"');
        if (!queued && !line.includes('"type":"user"')) continue;
        try {
          const d = JSON.parse(line);
          const c = queued ? (d.operation === 'enqueue' ? d.content : '') : d.message?.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
          if (text.replace(/\s+/g, ' ').toLowerCase().includes(want)) return queued ? 'queued' : 'sent';
        } catch { /* partial line */ }
      }
    } catch { /* transient */ }
  }
  return false;
}

const SEND_REASONS = {
  'not-front': 'The Claude app was not in front.',
  'not-front-after': 'Another app came to the front while pasting.',
  'not-pasted': 'The pasted text could not be confirmed in the message box, so Enter was not pressed. Check it in the app and press Enter yourself.',

  'not-focused': "The app didn't switch to that session in time.",
};

// One log line per send: steps and macOS answers only, never the text.
const sendLog = (appId, msg) => console.log(`[send-to-agent] ${new Date().toISOString()} ${appId}: ${msg}`);

export async function sendToApp(s, text) {
  if (!s.appId) return { ok: false, out: 'This is not a Claude app session.' };
  if (!text || text.length > 20000) return { ok: false, out: 'Write something (up to 20,000 characters).' };
  const status = await automationStatus();
  if (!status.ok) { sendLog(s.appId, `not allowed: ${status.why} ${status.out}`); return { ...status, ok: false, out: `Send to agent isn't allowed yet (${status.why}). Your reply was not sent.` }; }
  const before = await pipeTo('pbpaste');
  await pipeTo('pbcopy', text);
  const t0 = Date.now();
  await run('open', [`claude://claude.ai/epitaxy/${s.appId}`]);
  // Wait until the app itself reports this exact session focused, with the app in front: either it
  // was focused just now, or it already was the most recently focused session (re-opening it changes nothing).
  const othersFocusedAt = Math.max(0, ...[...appMeta.values()].filter((x) => x.appId !== s.appId).map((x) => x.lastFocusedAt || 0));
  let focused = false;
  for (let i = 0; i < 30 && !focused; i++) {
    await sleep(200);
    try {
      const at = JSON.parse(await fsp.readFile(appFiles.get(s.appId), 'utf8')).lastFocusedAt || 0;
      focused = (at >= t0 - 1000 || at > othersFocusedAt) && (await frontApp()) === 'Claude';
    } catch { /* file mid-write */ }
  }
  if (!focused) {
    let at = 0; try { at = JSON.parse(await fsp.readFile(appFiles.get(s.appId), 'utf8')).lastFocusedAt || 0; } catch { /* */ }
    sendLog(s.appId, `not focused: front=${await frontApp()} lastFocusedAt=${at} t0=${t0} othersMax=${othersFocusedAt} file=${appFiles.has(s.appId)}`);
    return { ok: false, out: `${SEND_REASONS['not-focused']} Your reply is on the clipboard: paste it there.` };
  }
  await sleep(600); // let the composer take focus after the switch
  const probe = text.replace(/\s+/g, ' ').trim().slice(0, 40);
  await refreshTranscript(s.sessionId);
  const fromSize = transcripts.get(s.sessionId)?.size || 0;
  const r = await runOsa(PASTE_AND_ENTER);
  sendLog(s.appId, `typed: out=${r.out || '-'} err=${r.err || '-'}`);
  if (r.out !== 'typed') return { ok: false, out: `Not sent: ${SEND_REASONS[r.out] || r.err || r.out} Your reply is on the clipboard.` };
  const seen = await seenInTranscript(s.sessionId, fromSize, probe.toLowerCase());
  sendLog(s.appId, `confirmed in transcript: ${seen}`);
  if (seen) {
    setTimeout(() => { if (before.ok) pipeTo('pbcopy', before.out); }, 1500); // give your clipboard back
    return { ok: true, out: seen === 'queued' ? 'Sent ✓ The session is busy, so it is queued and runs next.' : 'Sent ✓ It arrived in the session.' };
  }
  return { ok: false, out: "Pasted and pressed Enter, but the reply didn't show up in the session within 8 seconds. Check the Claude app; your reply is still on the clipboard." };
}
