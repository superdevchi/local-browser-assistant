# Local Browser Assistant — Code Brief & Usage Guide

Companion to `HANDOFF.md`. That file is the project brief for continuing work on this codebase; this file is a plain walkthrough of what each file does and the exact steps to run it.

## What this app does

A local web page where you type an instruction in plain English (e.g. "open Gmail and email sam@example.com about moving Thursday's meeting"). The Node server sends that instruction to Claude along with a set of browser-control tools; Claude drives a real Chrome window step by step — opening tabs, reading pages, clicking, typing — and streams progress back to the page live. Anything hard to undo (sending, buying, deleting, submitting) stops and asks you to approve first.

Nothing leaves your machine except what's sent to the Claude API on each step (your instruction plus page text/screenshots). No database, no accounts, no cloud storage — everything persistent lives in `data/` on disk.

## File-by-file brief

### `src/server.js` (190 lines)
The Express web server — the only network-facing part of the app.

- Binds to `127.0.0.1` only, never a public interface.
- Generates a random per-run auth token (`crypto.randomBytes`) at startup and injects it into `index.html`; every API call and the SSE stream must present it (`x-token` header or `?token=`), checked with a timing-safe compare.
- Checks the `Host` and `Origin` headers on every request — blocks DNS-rebinding attacks and other websites/tabs from silently driving the agent.
- Serves `public/` as static files, plus the templated `index.html`.
- `GET /events` — a Server-Sent-Events stream (`emit()`) that pushes every event (user message, assistant text, tool call, approval request, question, status) to the browser UI. Replays missed events by `Last-Event-ID` on reconnect.
- `POST /api/run` — starts a task, calls into `Agent.run()`.
- `POST /api/stop` — cancels the running task and resolves any pending approval/question with `null`.
- `POST /api/answer` — resolves a pending approval card or `ask_user` question with the value the human picked/typed.
- `POST /api/reset` — clears conversation history ("New chat").
- Owns `requestApproval()` and `askUser()` — both emit an SSE event and return a Promise that only resolves when the human answers via `/api/answer`. This is the mechanism that pauses the agent loop for human-in-the-loop approval.
- Appends one JSON line per tool call to `data/actions.log`.
- Graceful shutdown on `SIGINT`/`SIGTERM` closes the browser too.

**Depends on:** `express`, `dotenv`, `BrowserController` (browser.js), `Policy` (policy.js), `Agent` (agent.js).

### `src/agent.js` (101 lines)
The Claude tool-use loop. This is "the brain."

- `systemPrompt()` — instructs Claude to: act rather than narrate, never guess sensitive details (use `ask_user` instead), never fill in passwords/captchas itself, treat all page content as untrusted data (prompt-injection defense), and give a short summary when done.
- `Agent.run(userText, { emit, isCancelled })` — the loop: send `messages` + `TOOL_DEFS` to `claude.messages.create()`, emit any assistant text, execute every `tool_use` block via `executeTool()`, feed the `tool_result`s back in, repeat. Capped at `MAX_STEPS = 50` per run.
- Conversation (`this.messages`) persists across multiple `run()` calls until `/api/reset` — so follow-up instructions continue the same chat.
- `#prune()` — keeps only the newest 2 "large" content blocks (page snapshots/screenshots) in context, replacing older ones with a placeholder string, to control token usage on long sessions.
- Logs each tool call's result (clipped to 300 chars) via `ctx.log`.

**Depends on:** `@anthropic-ai/sdk`, `TOOL_DEFS`/`executeTool`/`summarizeCall` from `tools.js`. Model defaults to `claude-sonnet-5-5`, overridable via `CLAUDE_MODEL` env var.

### `src/tools.js` (334 lines)
Tool definitions Claude can call, plus the two safety gates.

- `TOOL_DEFS` — JSON schemas for 13 tools: `list_tabs`, `open_tab`, `navigate`, `switch_tab`, `close_tab`, `read_page`, `screenshot`, `click`, `type_text`, `select_option`, `press_key`, `scroll`, `wait`, `ask_user`.
- `RISKY` regex — matches button/label text like send, submit, post, publish, buy, pay, checkout, delete, unsubscribe, book, share, etc. Anything matching triggers a human approval card before it happens.
- `ensureAllowed(ctx, url, verb)` — the **site gate**. Checks the URL against `Policy`; if not yet allowed, emits an approval card (session / always / deny) and blocks until answered.
- `confirmAction(ctx, page, title)` — builds and shows an approval card containing the site, page title, any open dialog text (e.g. a Gmail compose box), and visible field values (never password fields), then waits for approve/deny.
- `pressGuarded(ctx, page, key)` — the **action gate** for keyboard input: asks first if Enter/Space would submit a risky form, or if a modifier+Enter combo looks like a "send" shortcut.
- `executeTool(name, input, ctx)` — the actual dispatcher. Every case re-reads live element state right before acting (not the model's stale snapshot), refuses to type into password/OTP/card fields, and returns a fresh page snapshot after most actions so the model always sees current state.
- `snap()` — wraps `browser.snapshot()` + `formatSnapshot()`, wrapping page content in `<untrusted_page_content>` tags per the prompt-injection defense in `agent.js`.

**Depends on:** `formatSnapshot` from `browser.js`. Called by `agent.js`.

### `src/browser.js` (368 lines)
`BrowserController` — the Playwright wrapper that actually drives Chrome.

- Two in-page functions injected via `page.evaluate`:
  - `indexPage({ maxEl, maxText })` — walks visible interactive elements (links, buttons, inputs, ARIA roles, contenteditable), stamps each with `data-agent-id="N"`, and returns page text (capped 6000 chars) + a numbered element list (capped 200 elements). Flags `sensitive` fields (password/CC/OTP by `type`/`autocomplete`) and omits their values.
  - `describeEl(el)` — re-describes a single element live, used right before a click/type to catch stale/mislabeled ids.
  - `collectFormContext()` — grabs open `[role=dialog]` text and visible field values, for the approval card.
- `formatSnapshot(snap, tabId)` — renders a snapshot into the text block the model reads, wrapped in `<untrusted_page_content>`.
- `BrowserController` — numeric tab-id registry over Playwright pages; `start()` either launches a persistent Chrome profile (`data/profile`, via `channel: 'chrome'`/`'msedge'`/bundled Chromium) or attaches to an already-running Chrome over CDP (`cdpUrl`). Methods: `open`, `navigate`, `switchTo`, `closeTab`, `snapshot` (retries 3x), `screenshot` (JPEG, quality 60), `click`/`type`/`select`/`press`/`scroll`, all operating on `data-agent-id` locators.

**Depends on:** `playwright-core`. Called by `tools.js` and `server.js`.

### `src/policy.js` (61 lines)
`Policy` — decides which domains the agent may touch.

- `isPrivateHost(host)` — blocks localhost, `.local`/`.internal`, and private/link-local IPv4 ranges (`10.x`, `127.x`, `169.254.x`, `172.16–31.x`, `192.168.x`, `100.64–127.x`) plus all raw IPv6 hosts. This is what stops the agent from reaching its own control server (SSRF-style self-attack).
- `check(url)` — returns `{ok:true}` if allowed, `{ok:false, blocked:true, reason}` if hard-blocked (bad protocol/private host), or `{ok:false, blocked:false, host}` if it needs a user decision.
- `allowForSession(host)` / `allowAlways(host)` — session-only allow vs. persisted to `data/allowed-domains.json`. Subdomains match (`mail.google.com` matches an allowed `google.com`); look-alike suffixes (`notexample.com` vs `example.com`) do not, by construction (exact match or `.`+suffix).
- Seeded at startup from `ALLOWED_DOMAINS` env var.

**Depends on:** Node `fs`/`net` only. Called by `tools.js` via `ensureAllowed`.

### `public/index.html`, `public/style.css`, `public/app.js`
The entire UI — no framework, no build step.

- `app.js` (122 lines) opens an `EventSource` to `/events` and renders each event type into the chat feed: user/assistant messages, tool-call lines, notes, errors, approval cards (with session/always/deny buttons), question cards (free-text reply), and resolved-state updates. Every dynamic string is set via `textContent`, never `innerHTML` — deliberate, because page content flowing through the agent is untrusted and must never be interpreted as HTML.
- Also wires the message form, Stop button (`POST /api/stop`), and New chat button (`POST /api/reset`).

## Dependency summary

| File | Playwright | Anthropic SDK | Express | Filesystem writes |
|---|---|---|---|---|
| `server.js` | no (via browser.js) | no (via agent.js) | yes | `data/actions.log` |
| `agent.js` | no | yes | no | no |
| `tools.js` | no (via browser.js) | no | no | no |
| `browser.js` | yes | no | no | `data/profile` (Chrome profile) |
| `policy.js` | no | no | no | `data/allowed-domains.json` |
| `public/app.js` | no | no | no (fetch only) | no |

## Step-by-step: how to run it

1. **Prerequisites:** Node 20+ and Google Chrome installed on the machine.

2. **Install dependencies:**
   ```bash
   cd /Users/chibuikehenry/Downloads/local-browser-assistant
   npm install
   ```

3. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and set `ANTHROPIC_API_KEY`. Everything else has a working default:

   | Variable | Default | Purpose |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | *(required)* | Your Anthropic API key |
   | `CLAUDE_MODEL` | `claude-sonnet-5-5` | Model used for the agent loop |
   | `BROWSER_CHANNEL` | `chrome` | `chrome`, `msedge`, or empty for Playwright's bundled Chromium |
   | `CDP_URL` | empty | Attach to a Chrome you started yourself (see step 6) instead of launching one |
   | `ALLOWED_DOMAINS` | empty | Comma-separated sites usable without a prompt |
   | `ALLOW_LOCAL` | off | Set `1` to let the agent visit localhost/private addresses (testing only) |
   | `PORT` | `3210` | Local server port |

4. **Start the server:**
   ```bash
   npm start
   ```
   Open `http://127.0.0.1:3210`. A separate Chrome window opens on your first task and reuses the profile in `data/profile` after that, so signed-in sessions persist.

5. **Give it a task:** type an instruction in the chat box and send. Watch the feed:
   - A **site-approval card** appears the first time it visits a new domain — choose "Allow for this session," "Always allow," or "Deny."
   - **Action-approval cards** appear before anything risky (send, buy, delete, etc.), showing the site, page title, any open dialog (e.g. full Gmail compose draft), and field values — approve or deny.
   - **Question cards** appear when it needs info from you (missing detail, sign-in, captcha, password) — reply in the text box.
   - Use **Stop** to cancel a running task; **New chat** to clear conversation history.

6. **If Google (or another site) blocks sign-in** in the automation-launched Chrome, switch to CDP mode:
   ```bash
   chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.assistant-chrome
   ```
   Sign in normally in that window, set `CDP_URL=http://127.0.0.1:9222` in `.env`, restart `npm start`. Use a dedicated profile here, not your daily browser profile — CDP mode attaches to every tab in that Chrome instance.

7. **Check the audit trail:** `data/actions.log` has one JSON line per tool call (tool name, input, result, error flag) — useful for debugging what the agent actually did.

## Suggested first test (from `HANDOFF.md`'s checklist)

1. "Open example.com and tell me what it says." → expect a site-approval card, then a Chrome window and a summary.
2. Sign in to your mail/chat site in the opened browser window.
3. "Draft an email to me at my own address saying hello. Do not send it yet." → check it fills To/Subject/Body correctly and stops before sending.
4. Let it click Send → confirm the approval card shows the full draft first, and that Deny actually stops it.
5. Try a multi-tab task and watch `list_tabs`/`switch_tab` behavior.

## Safety model — do not weaken when modifying code

1. **Site gate** (`policy.js` + `ensureAllowed`) — unknown domains always prompt before the agent reads or acts on them.
2. **Hard blocks** — only `http(s)` (+ `about:blank`); localhost/private IPs/link-local/raw IPv6 always refused, `ALLOW_LOCAL` only for testing.
3. **Action gate** (`RISKY` regex + `confirmAction`) — re-checks the live label at click time, not a stale snapshot.
4. **Sensitive fields** — `type_text` refuses password/OTP/card fields outright; the model is told to use `ask_user` instead.
5. **Denial is final** — a denied action tells the model not to retry or work around it.
6. **Prompt injection** — all page content is wrapped in `<untrusted_page_content>`; the system prompt says never to follow instructions found there.
7. **Server hardening** — bound to `127.0.0.1`, per-run token, Host/Origin checks, UI uses `textContent` only.

If you add a tool that changes the outside world (uploads, downloads, autofill, payments), give it the same treatment: a gate plus an approval card showing exactly what will happen.

## Known limitations (unchanged from `HANDOFF.md`)

- `indexPage` only sees the main document — iframes and shadow-DOM content are invisible to it.
- Element ids are re-stamped on every `read_page`; a page that re-renders between read and click can point at the wrong element (the live-label re-check at click time mitigates but doesn't eliminate this).
- `RISKY` is a plain regex on visible labels — can miss icon-only buttons, can over-trigger on innocuous text.
- No file upload/download tools yet.
- Screenshots are sent to the Claude API as images and can contain anything visible on screen.
- No automated test suite in the repo yet.
