import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserController } from './browser.js';
import { Policy } from './policy.js';
import { Agent } from './agent.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
fs.mkdirSync(DATA, { recursive: true });

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY. Copy .env.example to .env and add your key.');
  process.exit(1);
}

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3210);
const TOKEN = crypto.randomBytes(24).toString('hex');
const okHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const okOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

/* ---------- event hub (server-sent events) ---------- */
const clients = new Set();
const history = [];
let seq = Date.now();

function emit(session, type, data = {}) {
  const ev = { type, session, ...data };
  const id = ++seq;
  history.push({ id, ev });
  if (history.length > 500) history.shift();
  const chunk = `id: ${id}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.write(chunk);
}

/* ---------- questions / approvals waiting on the user ---------- */
const pending = new Map(); // id -> { resolve, session }
let nextId = 1;
const waitFor = (id, session) => new Promise((resolve) => pending.set(id, { resolve, session }));

async function requestApproval(session, req) {
  const id = String(nextId++);
  emit(session, 'approval', { id, ...req });
  const value = await waitFor(id, session);
  const final = req.options.includes(value) ? value : 'deny';
  emit(session, 'resolved', { id, value: final });
  return final;
}

async function askUser(session, question) {
  const id = String(nextId++);
  emit(session, 'ask', { id, question });
  const value = await waitFor(id, session);
  emit(session, 'resolved', { id, value: value == null ? 'cancelled' : 'answered' });
  return value == null ? null : String(value);
}

// Only cancels approvals/questions belonging to the given session, so stopping one
// tab's task never interrupts another tab's task running at the same time.
function cancelPending(session) {
  for (const [id, entry] of pending) {
    if (entry.session !== session) continue;
    pending.delete(id);
    entry.resolve(null);
  }
}

/* ---------- assistant wiring ---------- */
const browser = new BrowserController({
  profileDir: path.join(DATA, 'profile'),
  channel: process.env.BROWSER_CHANNEL === undefined ? 'chrome' : process.env.BROWSER_CHANNEL,
  cdpUrl: process.env.CDP_URL || '',
});
const policy = new Policy({
  file: path.join(DATA, 'allowed-domains.json'),
  initial: (process.env.ALLOWED_DOMAINS || '').split(','),
  allowLocal: process.env.ALLOW_LOCAL === '1',
});
const logToFile = (entry) =>
  fs.appendFile(path.join(DATA, 'actions.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', () => {});

// Each browser tab in the page is its own conversation (its own Agent), so opening a
// new tab never touches another tab's history. They share the one real Chrome
// window/profile and site policy, but each has its own active tab (see browser.js's
// activeBySession) so tasks in different tabs can run at the same time.
const sessions = new Map(); // session id -> Agent
// `incognito` only takes effect the first time a session is created (its first message);
// it can't change mid-conversation since tabs may already be open under the other mode.
function getSession(id, incognito = false) {
  let agent = sessions.get(id);
  if (!agent) {
    agent = new Agent({
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
      ctx: {
        browser,
        policy,
        incognito: !!incognito,
        session: id,
        requestApproval: (req) => requestApproval(id, req),
        askUser: (q) => askUser(id, q),
        log: (entry) => logToFile({ session: id, ...entry }),
      },
    });
    sessions.set(id, agent);
  }
  return agent;
}

const runningSessions = new Set(); // session ids currently mid-task
const cancelledSessions = new Set(); // session ids whose current run should stop

/* ---------- http ---------- */
const app = express();
app.disable('x-powered-by');

// Only accept requests addressed to us on localhost (blocks DNS-rebinding and other websites).
app.use((req, res, next) => {
  if (!okHosts.has(req.headers.host)) return res.status(403).send('Forbidden host');
  if (req.headers.origin && !okOrigins.has(req.headers.origin)) return res.status(403).send('Forbidden origin');
  next();
});

const auth = (req, res, next) => {
  const t = String(req.headers['x-token'] || req.query.token || '');
  const a = Buffer.from(t);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).send('Unauthorized');
  next();
};

app.get('/', (req, res) => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace('__TOKEN__', TOKEN);
  res.type('html').set('Cache-Control', 'no-store').send(html);
});
app.use(express.static(PUBLIC, { index: false }));
app.use(express.json({ limit: '100kb' }));

app.get('/events', auth, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const last = Number(req.headers['last-event-id'] || 0);
  for (const h of history) if (h.id > last) res.write(`id: ${h.id}\ndata: ${JSON.stringify(h.ev)}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

function friendly(e) {
  if (e?.status === 401) return 'The Anthropic API rejected the key (401). Check ANTHROPIC_API_KEY in .env.';
  if (e?.status === 404) return `Model not found (404). Check CLAUDE_MODEL in .env.`;
  if (e?.status === 429) return 'Rate limited by the API (429). Wait a bit and try again.';
  return String(e?.message || e).slice(0, 500);
}

app.post('/api/run', auth, (req, res) => {
  const task = String(req.body?.task || '').trim();
  const sessionId = String(req.body?.session || '').trim();
  const incognito = !!req.body?.incognito;
  if (!task) return res.status(400).json({ error: 'Empty message.' });
  if (!sessionId) return res.status(400).json({ error: 'Missing session.' });
  if (runningSessions.has(sessionId)) return res.status(409).json({ error: 'This tab is already working.' });
  const agent = getSession(sessionId, incognito);
  runningSessions.add(sessionId);
  cancelledSessions.delete(sessionId);
  res.status(202).json({ ok: true });
  emit(sessionId, 'user', { text: task });
  emit(sessionId, 'status', { running: true });
  agent
    .run(task, { emit: (type, data) => emit(sessionId, type, data), isCancelled: () => cancelledSessions.has(sessionId) })
    .catch((e) => emit(sessionId, 'error', { text: friendly(e) }))
    .finally(() => {
      runningSessions.delete(sessionId);
      emit(sessionId, 'status', { running: false });
    });
});

app.post('/api/stop', auth, (req, res) => {
  const sessionId = String(req.body?.session || '').trim();
  if (!sessionId) return res.status(400).json({ error: 'Missing session.' });
  cancelledSessions.add(sessionId);
  cancelPending(sessionId);
  res.json({ ok: true });
});

app.post('/api/answer', auth, (req, res) => {
  const id = String(req.body?.id ?? '');
  const entry = pending.get(id);
  if (!entry) return res.status(404).json({ error: 'Nothing is waiting on that.' });
  pending.delete(id);
  entry.resolve(req.body?.value ?? null);
  res.json({ ok: true });
});

// Clears one tab's conversation. Other tabs (other sessions) are untouched.
app.post('/api/reset', auth, (req, res) => {
  const sessionId = String(req.body?.session || '').trim();
  if (!sessionId) return res.status(400).json({ error: 'Missing session.' });
  if (runningSessions.has(sessionId)) return res.status(409).json({ error: 'Stop the current task first.' });
  sessions.delete(sessionId);
  emit(sessionId, 'reset');
  res.json({ ok: true });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`\nBrowser Assistant is running.\nOpen  http://127.0.0.1:${PORT}\n`);
});

async function shutdown() {
  server.close();
  await browser.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
