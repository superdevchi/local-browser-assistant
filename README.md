# Local Browser Assistant

A local-first personal assistant that drives a real Chrome browser for you. Type an instruction in plain English — "open Gmail and email sam@example.com about moving Thursday's meeting" — and Claude operates the browser step by step: opening tabs, reading pages, clicking, typing. Anything hard to undo (sending, buying, deleting, submitting) pauses and asks you to approve it first.

It runs entirely on your own machine with your own Anthropic API key. There's no database, no accounts, and no cloud storage — your browser profile, action log, and site allow-list all live in `data/` on disk. The only thing that ever leaves your computer is what gets sent to the Claude API on each step (your instructions plus the page text/screenshots it's currently looking at).

![Browser Assistant driving multiple private tabs side by side with the real browser window](docs/screenshot.png)

## What it can do

- **Multiple tabs, independent conversations.** Each tab in the app is its own chat with its own history. Starting a new task opens a new tab instead of wiping the old one, and tabs can run tasks at the same time.
- **Private tabs.** Toggle "Private" before a tab's first message to run that task in a real, visually-distinct incognito Chrome window — nothing from it (cookies, sign-ins, history) is saved to disk.
- **Approval gates on anything risky.** Clicking something labeled send, submit, buy, pay, delete, and similar always shows you exactly what's about to happen (including the full draft of an email or message) before it happens. Denying is final — the assistant won't retry or work around it.
- **Site allow-listing.** The assistant asks before it visits or acts on a domain you haven't approved yet, with options to allow just for this session or always.
- **Account creation support.** It can type a password into a password field when signing you up for something new (and will tell you what it used), but it will never touch a payment field, a one-time code, or an existing saved password — those always come back to you to enter yourself in the browser window.
- **Prompt-injection aware.** Page content is treated as untrusted data, never as instructions — even if a page tries to tell the assistant to do something.

## Requirements

- Node 20+
- Google Chrome installed
- An Anthropic API key

## Step-by-step setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure your API key**
   ```bash
   cp .env.example .env
   ```
   Open `.env` and set `ANTHROPIC_API_KEY`. Everything else has a sensible default — see `HANDOFF.md` for the full list of options (model, browser channel, allowed domains, etc.).

3. **Start the app**
   ```bash
   npm start
   ```
   Open the URL it prints (`http://127.0.0.1:3210`).

4. **Give it a task.** Type an instruction in the chat box and send it. A separate Chrome window opens on your first task — sign in to whatever sites you need there once; the session is kept in `data/profile` so you stay signed in next time.

5. **Approve as you go.** When the assistant wants to visit a new site or do something hard to undo, a card appears asking you to approve, deny, or (for sites) allow it going forward. It'll also ask you directly if it needs something only you can provide — a sign-in, a captcha, a password, a missing detail.

6. **Use tabs for parallel or unrelated work.** Click **+ New tab** to start a fresh conversation without losing the current one — useful if you want to kick off a second task while the first is still running. Check **Private** before a tab's first message if you don't want that task's browsing to be saved anywhere.

7. **Stop or reset anytime.** **Stop** cancels whatever the active tab is doing right now. Closing a tab (×) clears just that tab's conversation — other tabs are untouched.

For architecture details, the full safety model, known limitations, and a file-by-file breakdown of the codebase, see `HANDOFF.md` and `USAGE.md`.
