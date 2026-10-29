#!/usr/bin/env node
// CC Mission Control: one live control room for every local Claude Code session.
// Unofficial and not affiliated with Anthropic.
// Zero dependencies. Reads ~/.claude/sessions (live registry) and
// ~/.claude/projects (transcripts); drives sessions through the `claude` CLI.
// This file starts the background scans and the HTTP server; the work lives in src/.
import fs from 'node:fs';
import { scanAppMeta } from './src/app-meta.mjs';
import { HOST, PORT, SESS_DIR } from './src/config.mjs';
import { server } from './src/http.mjs';
import { linearTick } from './src/linear.mjs';
import { prTick } from './src/prs.mjs';
import { clients, tick } from './src/state.mjs';
import { scanTranscripts } from './src/transcript.mjs';

await scanTranscripts();
await scanAppMeta();
await tick();
setInterval(scanAppMeta, 4000);
setInterval(tick, 1000);
linearTick().then(prTick);
setInterval(linearTick, 3000);
setInterval(prTick, 30000);
setInterval(scanTranscripts, 15000);
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);
try { fs.watch(SESS_DIR, () => tick()); } catch { /* polling covers it */ }
// A failed background job (a tick, a scan) is logged; it must not take the console down.
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Port ${PORT} is already in use. Is CC Mission Control already running? Run cc-mission-control open, or pick another port with --port.`);
  process.exit(1);
});
server.listen(PORT, HOST, () => console.log(`CC Mission Control → http://localhost:${PORT} (sign in with: cc-mission-control open)`));
