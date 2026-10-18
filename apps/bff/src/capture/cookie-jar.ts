/**
 * Per-run cookie jar used when `CaptureContext.cookieJar` is set (FLOW-35, API-55, 04 §8.5).
 * Stores `Set-Cookie` values and sends matching cookies back. Deletion follows G-117: a clearing
 * cookie (`Max-Age=0`, empty value, past `Expires`) is NOT applied here; the proxy route (T-34)
 * drops the entry itself after a 200 `vp-session-results`, through `delete()`.
 */
interface Cookie {
  name: string;
  value: string;
  host: string;
  /** Domain attribute: also sent to subdomains */
  domain: string | null;
  path: string;
  secure: boolean;
}

function defaultPath(u: URL): string {
  const p = u.pathname;
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function pathMatches(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || reqPath.charAt(cookiePath.length) === '/';
}

export class CookieJar {
  private readonly cookies = new Map<string, Cookie>();

  /** reads every `Set-Cookie` of a response for `url` */
  store(url: URL, setCookies: readonly string[]): void {
    for (const sc of setCookies) {
      const [pair = '', ...attrs] = sc.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const c: Cookie = {
        name: pair.slice(0, eq).trim(),
        value: pair.slice(eq + 1).trim(),
        host: url.hostname.toLowerCase(),
        domain: null,
        path: defaultPath(url),
        secure: false,
      };
      let clearing = c.value === '';
      for (const a of attrs) {
        const [k = '', v = ''] = a.split('=').map((s) => s.trim());
        const key = k.toLowerCase();
        if (key === 'path' && v.startsWith('/')) c.path = v;
        else if (key === 'domain' && v) c.domain = v.replace(/^\./, '').toLowerCase();
        else if (key === 'secure') c.secure = true;
        else if (key === 'max-age' && Number(v) <= 0) clearing = true;
        else if (key === 'expires' && Date.parse(v) < Date.now()) clearing = true;
      }
      const id = `${c.domain ?? c.host}|${c.path}|${c.name}`;
      // G-117: a clearing cookie never removes a stored value here (T-34 owns the drop rule)
      if (clearing) continue;
      this.cookies.set(id, c);
    }
  }

  /** the `Cookie` header value for a request to `url`, or null */
  header(url: URL): string | null {
    const host = url.hostname.toLowerCase();
    const parts: string[] = [];
    for (const c of this.cookies.values()) {
      const hostOk = c.domain
        ? host === c.domain || host.endsWith(`.${c.domain}`)
        : host === c.host;
      if (!hostOk || !pathMatches(url.pathname, c.path)) continue;
      if (c.secure && url.protocol !== 'https:') continue;
      parts.push(`${c.name}=${c.value}`);
    }
    return parts.length ? parts.join('; ') : null;
  }

  delete(name: string): void {
    for (const [id, c] of this.cookies) if (c.name === name) this.cookies.delete(id);
  }

  get size(): number {
    return this.cookies.size;
  }
}
