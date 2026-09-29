import fs from 'node:fs';
import net from 'node:net';

function isPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  const h = host.replace(/^\[|\]$/g, '');
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
    );
  }
  return net.isIPv6(h); // raw IPv6 hosts are blocked outright
}

const matches = (set, host) => [...set].some((d) => host === d || host.endsWith('.' + d));

/** Decides which sites the agent may see or act on. */
export class Policy {
  constructor({ file, initial = [], allowLocal = false }) {
    this.file = file;
    this.allowLocal = allowLocal;
    this.always = new Set(initial.map((d) => d.trim().toLowerCase()).filter(Boolean));
    this.session = new Set();
    try {
      for (const d of JSON.parse(fs.readFileSync(file, 'utf8'))) this.always.add(String(d).toLowerCase());
    } catch {}
  }

  /** -> { ok } | { ok:false, blocked:true, reason } | { ok:false, blocked:false, host } */
  check(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, blocked: true, reason: `Invalid URL: ${url}` };
    }
    if (u.href === 'about:blank') return { ok: true };
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, blocked: true, reason: `Blocked: only http(s) pages are allowed (got ${u.protocol}).` };
    }
    const host = u.hostname.toLowerCase();
    if (!this.allowLocal && isPrivateHost(host)) {
      return { ok: false, blocked: true, reason: `Blocked: ${host} is a local/private address.` };
    }
    if (matches(this.always, host) || matches(this.session, host)) return { ok: true, host };
    return { ok: false, blocked: false, host };
  }

  allowForSession(host) {
    this.session.add(host);
  }

  allowAlways(host) {
    this.always.add(host);
    try {
      fs.writeFileSync(this.file, JSON.stringify([...this.always].sort(), null, 2));
    } catch {}
  }
}
