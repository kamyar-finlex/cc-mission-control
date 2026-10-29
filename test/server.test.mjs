// Runs the real server against a throwaway home folder: fixture transcripts, and a stub
// `claude` that only records the arguments it was given.
import { test as nodeTest, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SID = '11111111-2222-3333-4444-555555555555';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const HTML = Buffer.from('<script>alert(1)</script>').toString('base64');

// A broken server must fail a test, never hang the run.
const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn);

let home, dataDir, work, stubOut, server, port, token, cookie;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); });
});

// One request; resolves with { status, headers, body }. With headOnly it stops at the headers,
// for streams that never end.
function request(pathname, { method = 'GET', headers = {}, body, host, headOnly = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers: { Host: host || `localhost:${port}`, ...headers }, timeout: 5000 }, (res) => {
      if (headOnly) { req.destroy(); resolve({ status: res.statusCode, headers: res.headers }); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`${pathname} timed out`)));
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const act = (name, body, headers = { Cookie: cookie, 'X-Console-Request': '1', 'Content-Type': 'application/json' }) =>
  request(`/api/actions/${name}`, { method: 'POST', headers, body });

// Reads one SSE event of the given name from a stream.
function firstEvent(pathname, name, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers: { Host: `localhost:${port}`, ...headers }, timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve({ status: res.statusCode }); return; }
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        const m = buf.match(new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`));
        if (m) { req.destroy(); resolve({ status: 200, data: JSON.parse(m[1]) }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`${pathname} sent no ${name} event`)));
  });
}

const stubCalls = () => (fs.existsSync(stubOut) ? JSON.parse(fs.readFileSync(stubOut, 'utf8')) : null);

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccmc-home-'));
  dataDir = path.join(home, 'data');
  work = fs.mkdirSync(path.join(home, 'work'), { recursive: true }) && path.join(home, 'work');
  stubOut = path.join(home, 'stub-args.json');
  const stub = path.join(home, 'claude-stub');
  fs.writeFileSync(stub, `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.STUB_OUT, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });

  const now = new Date().toISOString();
  const lines = [
    { type: 'user', timestamp: now, cwd: work, gitBranch: 'main', message: { role: 'user', content: 'Please check the build' } },
    { type: 'assistant', timestamp: now, message: { model: 'claude-test', content: [{ type: 'text', text: 'Done &#x110000; and \u0001' + '9\u0001 fine' }] } },
    { type: 'user', timestamp: now, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'image', source: { type: 'base64', media_type: 'text/html', data: HTML } },
    ] }] } },
  ];
  const proj = path.join(home, '.claude', 'projects', '-work');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  port = await freePort();
  server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env: { PATH: process.env.PATH, HOME: home, CCMC_DATA_DIR: dataDir, PORT: String(port), CLAUDE_BIN: stub, STUB_OUT: stubOut },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.on('exit', () => server.kill());
  server.stderr.on('data', () => {}); // logged errors are expected in some tests
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 15000);
    server.stdout.on('data', (d) => { if (String(d).includes('CC Mission Control →')) { clearTimeout(t); resolve(); } });
    server.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
  token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();
  cookie = `ccmc_${port}=${token}`;
  // The first tick builds the session list.
  for (let i = 0; i < 50 && !(await firstEvent('/events', 'state', { Cookie: cookie })).data?.sessions?.some((s) => s.sessionId === SID); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(() => { server?.kill(); fs.rmSync(home, { recursive: true, force: true }); });

const alive = async () => (await request('/', { headers: { Cookie: cookie } })).status === 200;

test('a malformed request line gets 400 and the server keeps running', async () => {
  const reply = await new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET http://[ HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`));
    let out = '';
    sock.on('data', (d) => { out += d; sock.end(); });
    sock.on('close', () => resolve(out));
  });
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.ok(await alive());
});

test('only the console host names are served', async () => {
  assert.equal((await request('/', { host: 'evil.example' })).status, 403);
});

test('the page needs sign-in, and never contains the token', async () => {
  const anon = await request('/');
  assert.equal(anon.status, 401);
  assert.match(anon.body, /cc-mission-control open/);
  assert.ok(!anon.body.includes(token));

  assert.equal((await request('/?token=' + 'f'.repeat(32))).status, 403);

  const signIn = await request(`/?token=${token}`);
  assert.equal(signIn.status, 303);
  assert.equal(signIn.headers.location, '/');
  const set = signIn.headers['set-cookie'][0];
  assert.match(set, new RegExp(`^ccmc_${port}=${token};`));
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);

  const pageRes = await request('/', { headers: { Cookie: cookie } });
  assert.equal(pageRes.status, 200);
  assert.ok(!pageRes.body.includes(token));
  const nonce = pageRes.headers['content-security-policy'].match(/script-src 'nonce-([^']+)'/)[1];
  assert.ok(pageRes.body.includes(`<script nonce="${nonce}">`));
  assert.match(pageRes.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(pageRes.headers['x-content-type-options'], 'nosniff');
});

test('data routes need sign-in', async () => {
  for (const p of ['/events', '/api/digest', `/api/sessions/${SID}/stream`, '/api/images/0123456789abcdef0123', '/api/attachments/x.png', '/api/avatar/manifest']) {
    assert.equal((await request(p, { headOnly: true })).status, 401, p);
  }
  const digest = await request('/api/digest', { headers: { 'X-Console-Token': token } });
  assert.equal(digest.status, 200);
  assert.ok(JSON.parse(digest.body).projects);
});

test('actions need the page header or the token header, and a local Origin', async () => {
  const body = { sessionId: SID };
  assert.equal((await act('unarchive', body, { Cookie: cookie, 'Content-Type': 'application/json' })).status, 403);
  assert.equal((await act('unarchive', body, { Cookie: cookie, 'X-Console-Request': '1', Origin: 'https://evil.example' })).status, 403);
  assert.equal((await act('unarchive', body, { 'X-Console-Request': '1' })).status, 401, 'not signed in at all');
  assert.equal((await act('unarchive', body)).status, 200);
  assert.equal((await act('unarchive', body, { 'X-Console-Token': token })).status, 200);
});

test('actions without their session, bad JSON or huge bodies are refused, not fatal', async () => {
  for (const name of ['archive', 'send-app', 'terminal', 'stop', 'continue', 'summarize', 'check-open']) {
    const r = await act(name, { text: 'x' });
    assert.equal(r.status, 200, name);
    assert.equal(JSON.parse(r.body).ok, false, name);
  }
  assert.equal(JSON.parse((await act('archive', { sessionId: 'nope' })).body).ok, false);
  assert.equal((await act('archive', '{not json')).status, 400);
  assert.equal((await act('archive', '[1,2]')).status, 400);
  assert.equal((await act('archive', 'x'.repeat(1.2e6))).status, 413);
  assert.ok(await alive());
});

test('dispatch refuses bypassPermissions and passes the prompt after --', async () => {
  fs.rmSync(stubOut, { force: true });
  const refused = JSON.parse((await act('dispatch', { cwd: work, prompt: 'hi', permissionMode: 'bypassPermissions' })).body);
  assert.equal(refused.ok, false);
  assert.equal(JSON.parse((await act('dispatch', { cwd: work, prompt: 'hi', model: '--dangerously-skip-permissions' })).body).ok, false);
  assert.equal(JSON.parse((await act('dispatch', { cwd: 'relative/dir', prompt: 'hi' })).body).ok, false);
  assert.equal(stubCalls(), null, 'claude was never started');

  const ok = JSON.parse((await act('dispatch', { cwd: work, prompt: '--version', permissionMode: 'plan' })).body);
  assert.equal(ok.ok, true, ok.out);
  assert.deepEqual(stubCalls(), ['--bg', '--permission-mode', 'plan', '--', '--version']);
});

test('continue passes the reply after --', async () => {
  fs.rmSync(stubOut, { force: true });
  const r = JSON.parse((await act('continue', { sessionId: SID, text: '- item one\n- item two' })).body);
  assert.equal(r.ok, true, r.out);
  assert.deepEqual(stubCalls(), ['--bg', '--resume', SID, '--', '- item one\n- item two']);
});

test('transcript images: only image types are kept and served', async () => {
  const { data: events } = await firstEvent(`/api/sessions/${SID}/stream`, 'backlog', { Cookie: cookie });
  const result = events.find((e) => e.kind === 'result');
  assert.equal(result.images.length, 1, 'the text/html "image" is dropped');
  const img = await request(`/api/images/${result.images[0]}`, { headers: { Cookie: cookie } });
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/png');
  assert.equal(img.headers['x-content-type-options'], 'nosniff');
});

test('the data folder and token are owner-only', () => {
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dataDir, 'token')).mode & 0o777, 0o600);
});
