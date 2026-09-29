import { chromium } from 'playwright-core';

const MAX_ELEMENTS = 200;
const MAX_TEXT = 6000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- functions that run INSIDE the page (must be self-contained) ---------- */

function indexPage({ maxEl, maxText }) {
  document.querySelectorAll('[data-agent-id]').forEach((e) => e.removeAttribute('data-agent-id'));
  const sel = [
    'a[href]', 'button', 'input:not([type=hidden])', 'textarea', 'select', 'summary',
    '[role=button]', '[role=link]', '[role=textbox]', '[role=checkbox]', '[role=radio]',
    '[role=menuitem]', '[role=tab]', '[role=option]', '[role=combobox]', '[role=switch]',
    '[contenteditable=""]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
  ].join(',');
  const clean = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };
  const NON_TEXT = ['button', 'submit', 'checkbox', 'radio', 'image', 'reset', 'file', 'range', 'color'];
  const items = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (items.length >= maxEl) break;
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    // Passwords may be typed (needed for account creation); payment/one-time-code fields never are.
    // Either way the current value is never read back into a snapshot.
    const secret = type === 'password' ? 'password' : /^cc-/.test(ac) ? 'payment' : /one-time-code/.test(ac) ? 'otp' : '';
    const sensitive = !!secret;
    const blocked = secret === 'payment' || secret === 'otp';
    const editable =
      tag === 'textarea' || el.isContentEditable || (tag === 'input' && !NON_TEXT.includes(type));
    const labelFromFor = el.labels && el.labels[0] ? el.labels[0].innerText : '';
    const label = clean(
      el.getAttribute('aria-label') || labelFromFor || el.innerText || el.getAttribute('placeholder') ||
        el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') ||
        (['button', 'submit'].includes(type) ? el.value : ''),
      80
    );
    let value;
    if (!sensitive) {
      if (tag === 'select') value = clean(el.options[el.selectedIndex] && el.options[el.selectedIndex].text, 60);
      else if (editable) value = clean(tag === 'input' || tag === 'textarea' ? el.value : el.innerText, 120);
    }
    el.setAttribute('data-agent-id', String(++n));
    items.push({
      id: n, tag, type, role: el.getAttribute('role') || '', label,
      href: tag === 'a' ? (el.href || '').slice(0, 140) : '',
      value, checked: el.checked === true ? true : undefined,
      disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      sensitive, blocked, editable,
    });
  }
  const text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').slice(0, maxText);
  return {
    url: location.href, title: document.title, text, items,
    scrollY: Math.round(window.scrollY),
    scrollMax: Math.max(0, Math.round(document.documentElement.scrollHeight - window.innerHeight)),
  };
}

function describeEl(el) {
  const clean = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  const secret = type === 'password' ? 'password' : /^cc-/.test(ac) ? 'payment' : /one-time-code/.test(ac) ? 'otp' : '';
  const sensitive = !!secret;
  const blocked = secret === 'payment' || secret === 'otp';
  const NON_TEXT = ['button', 'submit', 'checkbox', 'radio', 'image', 'reset', 'file', 'range', 'color'];
  const isComposer = tag === 'textarea' || el.isContentEditable === true;
  const editable = isComposer || (tag === 'input' && !NON_TEXT.includes(type));
  const labelFromFor = el.labels && el.labels[0] ? el.labels[0].innerText : '';
  const label = clean(
    el.getAttribute('aria-label') || labelFromFor || el.innerText || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') ||
      (['button', 'submit'].includes(type) ? el.value : ''),
    80
  );
  const form = el.closest ? el.closest('form') : null;
  const submitTexts = form
    ? [...form.querySelectorAll('button, input[type=submit]')]
        .filter((b) => (b.getAttribute('type') || 'submit').toLowerCase() === 'submit')
        .map((b) => clean(b.getAttribute('aria-label') || b.innerText || b.value, 40))
    : [];
  return { tag, type, label, sensitive, blocked, editable, isComposer, submitTexts };
}

function collectFormContext() {
  const clean = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const dialogs = [...document.querySelectorAll('[role=dialog]')]
    .map((d) => (d.innerText || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500))
    .filter(Boolean);
  const fields = [];
  const q = 'input:not([type=hidden]):not([type=password]),textarea,select,[contenteditable=""],[contenteditable="true"]';
  for (const el of document.querySelectorAll(q)) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/^cc-|password|one-time-code/.test(ac)) continue;
    const name = clean(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name'), 40) || el.tagName.toLowerCase();
    const raw = 'value' in el ? el.value : el.innerText;
    const v = clean(raw, 600);
    if (v) fields.push(`${name}: ${v}`);
    if (fields.length >= 15) break;
  }
  return { dialogs: dialogs.slice(0, 2), fields };
}

/* ---------- formatting ---------- */

export function formatSnapshot(snap, tabId) {
  const scrub = (s) => String(s ?? '').replaceAll('</untrusted_page_content>', '[removed]');
  const lines = [];
  lines.push(`Tab ${tabId} | ${scrub(snap.title)} | ${snap.url}`);
  lines.push(`Scroll position: ${snap.scrollY}px of ${snap.scrollMax}px`);
  lines.push('<untrusted_page_content>');
  lines.push('PAGE TEXT:');
  lines.push(scrub(snap.text) || '(no visible text)');
  lines.push('');
  lines.push('INTERACTIVE ELEMENTS (use the number as element_id):');
  for (const it of snap.items) {
    let s = `[${it.id}] ${it.role || it.tag}`;
    if (it.type) s += `(${it.type})`;
    if (it.label) s += ` "${scrub(it.label)}"`;
    if (it.blocked) s += ' [payment/one-time-code field: you cannot read or fill this; ask the user to do it]';
    else if (it.sensitive) s += ' [password field: current value hidden; you may type_text into this to set a password]';
    else if (it.value) s += ` value="${scrub(it.value)}"`;
    else if (it.editable) s += ' value=""';
    if (it.checked) s += ' [checked]';
    if (it.disabled) s += ' [disabled]';
    if (it.href) s += ` -> ${scrub(it.href)}`;
    lines.push(s);
  }
  if (snap.items.length >= MAX_ELEMENTS) lines.push(`(list capped at ${MAX_ELEMENTS} elements; scroll for more)`);
  lines.push('</untrusted_page_content>');
  return lines.join('\n');
}

/* ---------- controller ---------- */

export class BrowserController {
  constructor({ profileDir, channel, cdpUrl }) {
    this.profileDir = profileDir;
    this.channel = channel;
    this.cdpUrl = cdpUrl;
    this.context = null; // persistent context: signed-in profile, saved to data/profile
    this.privateBrowser = null; // ephemeral browser + context for "Private" tabs: nothing is saved
    this.privateContext = null;
    this.conn = null;
    this.tabIds = new Map(); // Page -> numeric id (spans both contexts)
    this.nextId = 1;
    this.activeBySession = new Map(); // chat-session id -> its own active Page, so tabs can run concurrently
    this.starting = null;
    this.startingPrivate = null;
  }

  _register(page) {
    if (this.tabIds.has(page)) return;
    this.tabIds.set(page, this.nextId++);
    page.on('close', () => {
      this.tabIds.delete(page);
      for (const [sid, p] of this.activeBySession) if (p === page) this.activeBySession.delete(sid);
    });
  }

  async start() {
    if (this.context) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        if (this.cdpUrl) {
          this.conn = await chromium.connectOverCDP(this.cdpUrl);
          this.context = this.conn.contexts()[0];
          if (!this.context) throw new Error('Connected to Chrome but found no browser context.');
        } else {
          const opts = {
            headless: false,
            viewport: null,
            args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
            ignoreDefaultArgs: ['--enable-automation'],
          };
          if (this.channel) opts.channel = this.channel;
          this.context = await chromium.launchPersistentContext(this.profileDir, opts);
        }
      } catch (e) {
        const hint = this.cdpUrl
          ? `Could not attach to Chrome at ${this.cdpUrl}. Start Chrome with --remote-debugging-port and a dedicated --user-data-dir first.`
          : `Could not launch the browser (${this.channel || 'bundled chromium'}). Install Google Chrome, or set BROWSER_CHANNEL=msedge, or leave it empty after running: npx playwright-core install chromium`;
        throw new Error(`${hint}\n${String(e.message).split('\n')[0]}`);
      }
      this.tabIds.clear();
      this.context.pages().forEach((p) => this._register(p));
      this.context.on('page', (p) => this._register(p));
      this.context.on('close', () => {
        this.context = null;
        this.tabIds.clear();
        this.activeBySession.clear();
      });
      if (this.context.pages().length === 0) this._register(await this.context.newPage());
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  // The "Private" toggle: an ephemeral, non-persistent Chromium context. Cookies,
  // localStorage and history exist only in memory and vanish when this context closes.
  // Launched with --incognito so the window itself is visually distinct (dark UI, spy-glasses
  // icon) from the normal signed-in window — easy to tell apart when both are open at once.
  async _startPrivate() {
    if (this.privateContext) return;
    if (this.startingPrivate) return this.startingPrivate;
    this.startingPrivate = (async () => {
      const opts = {
        headless: false,
        args: ['--incognito', '--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
      };
      if (this.channel) opts.channel = this.channel;
      try {
        this.privateBrowser = await chromium.launch(opts);
      } catch (e) {
        throw new Error(`Could not launch a private browser window (${this.channel || 'bundled chromium'}). ${String(e.message).split('\n')[0]}`);
      }
      this.privateContext = await this.privateBrowser.newContext({ viewport: null });
      this.privateContext.on('page', (p) => this._register(p));
      this.privateContext.on('close', () => {
        this.privateContext = null;
      });
      this.privateBrowser.on('disconnected', () => {
        this.privateBrowser = null;
        this.privateContext = null;
      });
    })();
    try {
      await this.startingPrivate;
    } finally {
      this.startingPrivate = null;
    }
  }

  async _ctx(incognito) {
    if (incognito) {
      if (!this.privateContext) await this._startPrivate();
      return this.privateContext;
    }
    if (!this.context) await this.start();
    return this.context;
  }

  // Each chat session gets its own active tab, so two sessions running at once never
  // steal each other's "current tab" — the old single shared pointer couldn't do that.
  async ensure(incognito = false, sessionKey) {
    const want = await this._ctx(incognito);
    const cur = this.activeBySession.get(sessionKey);
    if (cur && !cur.isClosed() && cur.context() === want) return;
    const page = await want.newPage();
    this._register(page);
    this.activeBySession.set(sessionKey, page);
  }

  async close() {
    try {
      if (this.cdpUrl) await this.conn?.close();
      else await this.context?.close();
    } catch {}
    try {
      await this.privateBrowser?.close();
    } catch {}
  }

  idOf(page) {
    return this.tabIds.get(page);
  }

  pageById(id) {
    for (const [p, i] of this.tabIds) if (i === Number(id) && !p.isClosed()) return p;
    throw new Error(`No open tab with id ${id}. Use list_tabs to see current tabs.`);
  }

  resolve(tabId, sessionKey) {
    const page = tabId ? this.pageById(tabId) : this.activeBySession.get(sessionKey);
    return { page, id: this.idOf(page) };
  }

  async list(sessionKey) {
    const mine = this.activeBySession.get(sessionKey);
    const out = [];
    for (const [p, id] of this.tabIds) {
      if (p.isClosed()) continue;
      out.push({ id, active: p === mine, url: p.url(), title: await p.title().catch(() => '') });
    }
    return out;
  }

  async open(url, { incognito = false, session } = {}) {
    const ctx = await this._ctx(incognito);
    const page = await ctx.newPage();
    this._register(page);
    this.activeBySession.set(session, page);
    await this._goto(page, url);
    await page.bringToFront().catch(() => {});
    return page;
  }

  async navigate(page, url) {
    await this._goto(page, url);
    return page;
  }

  async _goto(page, url) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      if (!/Timeout/i.test(e.message)) throw new Error(String(e.message).split('\n')[0]);
    }
  }

  async switchTo(id, sessionKey) {
    const page = this.pageById(id);
    this.activeBySession.set(sessionKey, page);
    await page.bringToFront().catch(() => {});
    return page;
  }

  async closeTab(id) {
    await this.pageById(id).close();
  }

  async snapshot(page) {
    let lastErr;
    for (let i = 0; i < 3; i++) {
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        return await page.evaluate(indexPage, { maxEl: MAX_ELEMENTS, maxText: MAX_TEXT });
      } catch (e) {
        lastErr = e;
        await sleep(600);
      }
    }
    throw new Error(`Could not read the page: ${String(lastErr.message).split('\n')[0]}`);
  }

  async screenshot(page) {
    const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
    return buf.toString('base64');
  }

  _loc(page, id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n < 1) throw new Error('element_id must be a positive integer from read_page.');
    return page.locator(`[data-agent-id="${n}"]`).first();
  }

  async _existing(page, id) {
    const loc = this._loc(page, id);
    if ((await loc.count()) === 0) {
      throw new Error(`Element ${id} was not found. The page may have changed; call read_page for fresh element ids.`);
    }
    return loc;
  }

  async describe(page, id) {
    const loc = await this._existing(page, id);
    return loc.evaluate(describeEl, undefined, { timeout: 3000 });
  }

  async describeFocused(page) {
    const h = await page.evaluateHandle(() => document.activeElement);
    try {
      return await h.evaluate(describeEl);
    } finally {
      await h.dispose().catch(() => {});
    }
  }

  formContext(page) {
    return page.evaluate(collectFormContext);
  }

  async click(page, id) {
    const loc = await this._existing(page, id);
    const before = new Set(this.tabIds.values());
    await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    await loc.click({ timeout: 8000 });
    await sleep(900);
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return { opened: [...this.tabIds.values()].filter((t) => !before.has(t)) };
  }

  async type(page, id, text, clear) {
    const loc = await this._existing(page, id);
    await loc.scrollIntoViewIfNeeded({ timeout: 4000 }).catch(() => {});
    if (clear) await loc.fill(text, { timeout: 8000 });
    else {
      await loc.click({ timeout: 8000 });
      await loc.pressSequentially(text, { delay: 8, timeout: 30000 });
    }
  }

  async select(page, id, option) {
    const loc = await this._existing(page, id);
    try {
      await loc.selectOption({ label: option }, { timeout: 5000 });
    } catch {
      await loc.selectOption({ value: option }, { timeout: 5000 });
    }
  }

  async press(page, key) {
    await page.keyboard.press(key);
    await sleep(700);
  }

  async scroll(page, dy) {
    await page.evaluate((y) => window.scrollBy(0, y), dy);
    await sleep(300);
  }
}
