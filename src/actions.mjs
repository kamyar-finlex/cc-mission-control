import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { continueArgs, dispatchArgs } from '../lib/claude-args.mjs';
import { attachmentPath } from './attachments.mjs';
import { CLAUDE_BIN, USAGE_TASK_ID } from './config.mjs';
import { checkOpen, writeSummary } from './llm.mjs';
import { osa, run, sh } from './proc.mjs';
import { automationStatus, sendToApp } from './send-to-app.mjs';
import { consoleArchive, saveArchive, state, tick } from './state.mjs';

// The console's actions: what the page's buttons and menus ask the server to do.

function openTerminal(cwd, command) {
  const script = `tell application "Terminal"\n activate\n do script "cd ${osa(sh(cwd))} && ${osa(command)}"\nend tell`;
  return run('osascript', ['-e', script]);
}

const find = (sid) => state.sessions.find((s) => s.sessionId === sid);

// Actions that act on one session; each refuses to run without it.
const SESSION_ACTIONS = new Set(['send-app', 'archive', 'check-open', 'summarize', 'unarchive', 'terminal', 'stop', 'remove', 'continue']);
// Ids go on command lines, so only plain ids pass (transcript file names are UUIDs, job ids are short hex).
const SAFE_ID = /^[\w][\w-]{0,99}$/;

export async function act(name, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
  const s = body.sessionId ? find(String(body.sessionId)) : undefined;
  if ((body.sessionId || SESSION_ACTIONS.has(name)) && !s) return { ok: false, out: 'Session not found (it may have been cleaned up).' };
  if (s && !SAFE_ID.test(s.sessionId)) return { ok: false, out: 'This session has an unusual id, so the console will not pass it to a command.' };
  const needsJob = s?.kind === 'background' && ['archive', 'terminal', 'stop', 'remove'].includes(name);
  if (needsJob && !SAFE_ID.test(String(s.jobId || ''))) return { ok: false, out: 'This background agent has no usable job id.' };
  switch (name) {
    case 'refresh-usage': {
      // Nothing outside the app can run its scheduled task, so a stale reading opens
      // the task in the Claude app, where "Run now" takes one click.
      await tick();
      const plan = state.usage?.plan;
      if (plan && Date.now() - plan.updatedAt < 2 * 60e3) return { ok: true, out: 'Usage is up to date.' };
      await run('open', [`claude://claude.ai/epitaxy/scheduled/${USAGE_TASK_ID}`]);
      return { ok: true, opened: true, out: 'Opened the usage task in the Claude app. Click Run now there; the toolbar updates by itself when it finishes.' };
    }
    case 'open-ax-settings':
      return run('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility']);
    case 'automation-status':
      return automationStatus();
    case 'send-app':
      return sendToApp(s, String(body.text || '').trim());
    case 'open-app':
      // The app's own deep link for one Code session: it focuses exactly that session.
      if (s?.appId) return run('open', [`claude://claude.ai/epitaxy/${s.appId}`]);
      return run('open', ['-a', 'Claude']);
    case 'archive': {
      if (s.kind === 'background') {
        if (s.running) await run(CLAUDE_BIN, ['stop', s.jobId]);
        const r = await run(CLAUDE_BIN, ['rm', s.jobId]);
        if (!r.ok) return r;
      }
      consoleArchive.add(s.sessionId);
      await saveArchive();
      return { ok: true, out: s.appId ? 'Archived in the console. To archive it in the Claude app too, use the app.' : 'Archived.' };
    }
    case 'check-open':
      return checkOpen(s.sessionId);
    case 'summarize':
      return writeSummary(s.sessionId);
    case 'unarchive':
      if (s.appArchived && !consoleArchive.has(s.sessionId)) return { ok: false, out: 'This one was archived in the Claude app. Unarchive it there.' };
      consoleArchive.delete(s.sessionId);
      await saveArchive();
      return { ok: true, out: 'Back on the board.' };
    case 'terminal':
      if (s.kind === 'background' && s.running) return openTerminal(s.cwd, `${sh(CLAUDE_BIN)} attach ${sh(s.jobId)}`);
      if (s.running) return { ok: false, out: 'This session is already open elsewhere. Resuming it here would start a copy.' };
      return openTerminal(s.cwd, `${sh(CLAUDE_BIN)} --resume ${sh(s.sessionId)}`);
    case 'stop':
      if (s.kind !== 'background') return { ok: false, out: 'Only background agents can be stopped from here.' };
      return run(CLAUDE_BIN, ['stop', s.jobId]);
    case 'remove':
      if (s.kind !== 'background') return { ok: false, out: 'Only background agents can be removed from here.' };
      return run(CLAUDE_BIN, ['rm', s.jobId]);
    case 'continue': {
      const text = String(body.text || '').trim();
      if (!text) return { ok: false, out: 'Write a message first.' };
      if (s.running) return { ok: false, out: 'This session is running. Attach to it (background) or use the Claude app.' };
      if (!s.cwd || !fs.existsSync(s.cwd)) return { ok: false, out: `Its folder no longer exists: ${s.cwd || '(unknown)'}` };
      return run(CLAUDE_BIN, continueArgs(s.sessionId, text), { cwd: s.cwd });
    }
    case 'project-updates': {
      // A new Claude app session with the skill's command typed in; Claude writes, you confirm, then it posts.
      const range = ['today', 'yesterday', 'week'].includes(body.range) ? body.range : 'today';
      const prompt = range === 'today' ? '/project-updates' : `/project-updates ${range}`;
      const r = await run('open', [`claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(os.homedir())}`]);
      return r.ok ? { ok: true, out: 'A Claude app session is open with /project-updates typed in. Press Enter there; it shows the drafts and posts nothing until you say yes.' } : r;
    }
    case 'new-in-app': {
      // The Claude app's own link for a new Code session, with the prompt typed in and the folder chosen.
      const prompt = String(body.prompt || '').trim();
      const cwd = String(body.cwd || '').trim();
      if (!prompt || !cwd) return { ok: false, out: 'Folder and prompt are required.' };
      if (!path.isAbsolute(cwd) || !fs.existsSync(cwd)) return { ok: false, out: `No such folder: ${cwd}` };
      if (prompt.length > 14000) return { ok: false, out: 'The prompt is too long for the Claude app link (14,000 characters at most).' };
      const files = (Array.isArray(body.files) ? body.files : []).map(attachmentPath).filter((f) => f && fs.existsSync(f)).slice(0, 10);
      const fileParams = files.map((f) => `&file=${encodeURIComponent(f)}`).join('');
      const r = await run('open', [`claude://code/new?q=${encodeURIComponent(prompt)}&folder=${encodeURIComponent(cwd)}${fileParams}`]);
      return r.ok ? { ok: true, out: 'A new Claude app session is open with your prompt typed in. Press Enter there to start it.' } : r;
    }
    case 'dispatch': {
      const prompt = String(body.prompt || '').trim();
      const cwd = String(body.cwd || '').trim();
      if (!prompt || !cwd) return { ok: false, out: 'Folder and prompt are required.' };
      if (!path.isAbsolute(cwd) || !fs.existsSync(cwd)) return { ok: false, out: `No such folder: ${cwd}` };
      const { args, error } = dispatchArgs({ model: body.model, permissionMode: body.permissionMode, prompt });
      if (error) return { ok: false, out: error };
      return run(CLAUDE_BIN, args, { cwd });
    }
    default:
      return { ok: false, out: `Unknown action ${name}` };
  }
}
