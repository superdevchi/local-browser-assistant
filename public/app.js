const tabsEl = document.getElementById('tabs');
const feedWrap = document.getElementById('feedWrap');
const statusEl = document.getElementById('status');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const stopBtn = document.getElementById('stop');
const incognitoBox = document.getElementById('incognito');
const hintHTML = document.getElementById('hint-template').innerHTML;
const headers = { 'Content-Type': 'application/json', 'x-token': window.TOKEN };
const cards = new Map(); // approval/question id -> card element (unique across all tabs)
const sessions = new Map(); // session id -> { name, pane, tabBtn }
let activeId = null;
const runningSessions = new Set(); // tabs currently mid-task; several can run at once
let tabCount = 0;

const post = (path, body) => fetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function addToPane(pane, node) {
  const stick = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
  pane.appendChild(node);
  if (stick) pane.scrollTop = pane.scrollHeight;
  return node;
}

/* ---------- tabs ---------- */

function createTab(id, { select = true } = {}) {
  if (sessions.has(id)) return sessions.get(id);
  tabCount += 1;
  const pane = el('div', 'feed-pane');
  pane.innerHTML = hintHTML;
  feedWrap.appendChild(pane);

  const tabBtn = el('div', 'tab');
  const label = el('span', '', `Chat ${tabCount}`);
  const close = el('button', 'close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close tab');
  close.onclick = (e) => { e.stopPropagation(); closeTab(id); };
  tabBtn.append(label, close);
  tabBtn.onclick = () => switchTab(id);
  tabsEl.insertBefore(tabBtn, tabsEl.lastElementChild);

  const session = { name: label.textContent, pane, tabBtn, label, incognito: null };
  sessions.set(id, session);
  if (select) switchTab(id);
  return session;
}

function switchTab(id) {
  const session = sessions.get(id);
  if (!session) return;
  activeId = id;
  for (const [sid, s] of sessions) {
    s.pane.classList.toggle('active', sid === id);
    s.tabBtn.classList.toggle('active', sid === id);
  }
  incognitoBox.checked = !!session.incognito;
  incognitoBox.disabled = session.incognito !== null;
  refreshStatus();
  input.focus();
}

function closeTab(id) {
  const session = sessions.get(id);
  if (!session) return;
  if (runningSessions.has(id)) return; // don't close a tab that's actively working
  sessions.delete(id);
  session.pane.remove();
  session.tabBtn.remove();
  post('/api/reset', { session: id });
  if (sessions.size === 0) {
    createTab(newId());
  } else if (activeId === id) {
    switchTab(sessions.keys().next().value);
  }
}

function refreshStatus() {
  const busy = runningSessions.has(activeId);
  statusEl.textContent = busy ? 'Working…' : 'Idle';
  sendBtn.disabled = busy;
  stopBtn.disabled = !busy;
  for (const [sid, s] of sessions) s.tabBtn.classList.toggle('busy', runningSessions.has(sid));
}

/* ---------- cards (approval / question) ---------- */

const LABELS = {
  approve: 'Approve', deny: 'Deny', session: 'Allow for this session', always: 'Always allow this site',
};

function approvalCard(pane, ev) {
  const card = el('div', 'card');
  card.appendChild(el('h3', '', ev.title));
  if (ev.details && ev.details.length) card.appendChild(el('pre', '', ev.details.join('\n\n')));
  const row = el('div', 'row');
  for (const opt of ev.options) {
    const b = el('button', opt === 'deny' ? 'danger' : opt === 'approve' || opt === 'session' ? 'primary' : '', LABELS[opt] || opt);
    b.type = 'button';
    b.onclick = () => post('/api/answer', { id: ev.id, value: opt });
    row.appendChild(b);
  }
  card.appendChild(row);
  cards.set(ev.id, card);
  addToPane(pane, card);
}

function askCard(pane, ev) {
  const card = el('div', 'card');
  card.appendChild(el('h3', '', ev.question));
  const ta = el('textarea');
  ta.rows = 2;
  ta.placeholder = 'Type your reply…';
  const row = el('div', 'row');
  const ok = el('button', 'primary', 'Reply');
  ok.type = 'button';
  const submit = () => post('/api/answer', { id: ev.id, value: ta.value.trim() || '(no answer)' });
  ok.onclick = submit;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  row.appendChild(ok);
  card.append(ta, row);
  cards.set(ev.id, card);
  addToPane(pane, card);
  if (activeId === undefined || pane.classList.contains('active')) ta.focus();
}

function resolveCard(ev) {
  const card = cards.get(ev.id);
  if (!card) return;
  card.classList.add('done');
  card.querySelectorAll('button, textarea').forEach((n) => (n.disabled = true));
  card.appendChild(el('div', 'result', LABELS[ev.value] || (ev.value === 'answered' ? 'Answered' : 'Cancelled')));
}

/* ---------- event routing ---------- */

function handle(ev) {
  if (ev.type === 'status') {
    if (ev.running) runningSessions.add(ev.session);
    else runningSessions.delete(ev.session);
    refreshStatus();
    return;
  }

  const sessionId = ev.session || activeId;
  if (!sessionId) return;
  const session = sessions.get(sessionId) || createTab(sessionId, { select: false });
  const pane = session.pane;

  switch (ev.type) {
    case 'user': return addToPane(pane, el('div', 'msg user', ev.text));
    case 'assistant': return addToPane(pane, el('div', 'msg assistant', ev.text));
    case 'tool': return addToPane(pane, el('div', 'tool', '→ ' + ev.text));
    case 'note': return addToPane(pane, el('div', 'note', ev.text));
    case 'error': return addToPane(pane, el('div', 'error', ev.text));
    case 'approval': return approvalCard(pane, ev);
    case 'ask': return askCard(pane, ev);
    case 'resolved': return resolveCard(ev);
    case 'reset':
      pane.innerHTML = hintHTML;
      return;
  }
}

const es = new EventSource('/events?token=' + encodeURIComponent(window.TOKEN));
es.onmessage = (m) => handle(JSON.parse(m.data));
es.onerror = () => { statusEl.textContent = 'Reconnecting…'; };
es.onopen = () => { if (statusEl.textContent === 'Reconnecting…') refreshStatus(); };

/* ---------- actions ---------- */

async function send() {
  const task = input.value.trim();
  if (!task || sendBtn.disabled || !activeId) return;
  const session = sessions.get(activeId);
  const incognito = incognitoBox.checked;
  const r = await post('/api/run', { task, session: activeId, incognito });
  if (r.ok) {
    input.value = '';
    if (session.incognito === null) {
      session.incognito = incognito;
      incognitoBox.disabled = true;
      if (incognito) {
        session.label.textContent = '🔒 ' + session.label.textContent;
        session.tabBtn.title = 'Private tab — nothing is saved.';
      }
    }
  } else {
    addToPane(session.pane, el('div', 'error', (await r.json().catch(() => ({}))).error || 'Could not send.'));
  }
}

document.getElementById('form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
stopBtn.onclick = () => post('/api/stop', { session: activeId });

const addTabBtn = el('button', 'tab-add', '+ New tab');
addTabBtn.type = 'button';
addTabBtn.onclick = () => createTab(newId());
tabsEl.appendChild(addTabBtn);

createTab(newId());
