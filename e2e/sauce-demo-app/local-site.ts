import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A site on this machine that the device opens through Sauce Connect.
 *
 * Devices never send localhost or 127.0.0.1 through the tunnel, so the site uses a made-up host. Only that host goes
 * through the tunnel, and sc hands its requests to the server here as its upstream proxy: nothing resolves the name.
 * The server ends TLS with its own certificate (sc trusts it through --cacert-file and re-signs it for the device),
 * then serves its own page, or forwards to E2E_LOCAL_SITE (e.g. http://localhost:3001).
 */
export const LOCAL_SITE_HOST = 'mobilewright.test';
export const LOCAL_SITE_URL = `https://${LOCAL_SITE_HOST}`;
/** Text the test expects on the page: the built-in page's heading, or E2E_LOCAL_SITE_TEXT. */
export const LOCAL_SITE_TEXT = process.env['E2E_LOCAL_SITE_TEXT'] ?? 'Served from this machine';
/** `E2E_SAUCE_CONNECT=0` runs the suite without a tunnel (accounts without Sauce Connect for public devices). */
export const sauceConnectEnabled = process.env['E2E_SAUCE_CONNECT'] !== '0';

/**
 * The tunnel's options. Runs in every process that loads the config; the first one (the test runner) creates the
 * certificate and starts the site, and its workers inherit the settings through the environment.
 */
export function localSiteTunnelOptions() {
  if (!process.env['E2E_LOCAL_SITE_DIR']) {
    const dir = mkdtempSync(join(tmpdir(), 'mobilewright-e2e-site-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
      '-subj', `/CN=${LOCAL_SITE_HOST}`, '-addext', `subjectAltName=DNS:${LOCAL_SITE_HOST}`,
    ], { stdio: 'ignore' });
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
    process.env['E2E_LOCAL_SITE_DIR'] = dir;
    // One runner per platform can run at once, each with its own tunnel and site.
    process.env['E2E_LOCAL_SITE_PORT'] ??= String(20_000 + (process.pid % 10_000));
    startLocalSite(dir, Number(process.env['E2E_LOCAL_SITE_PORT']));
  }
  return {
    proxyLocalhost: 'allow' as const,
    proxy: `127.0.0.1:${process.env['E2E_LOCAL_SITE_PORT']}`,
    tunnelDomains: LOCAL_SITE_HOST.replace(/\./g, '\\.'),
    cacertFile: join(process.env['E2E_LOCAL_SITE_DIR']!, 'cert.pem'),
  };
}

/** Starts the site, the tunnel's upstream proxy. It doesn't keep the process alive. */
function startLocalSite(dir: string, port: number): void {
  const target = process.env['E2E_LOCAL_SITE'] ? new URL(process.env['E2E_LOCAL_SITE']) : undefined;

  const serve = (req: IncomingMessage, res: ServerResponse) => {
    // Plain HTTP through a proxy carries the full URL; requests inside a CONNECT carry only the path.
    const path = /^https?:/.test(req.url ?? '') ? new URL(req.url!).pathname + new URL(req.url!).search : req.url ?? '/';
    if (!target) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(localSitePage(req.headers['user-agent'] ?? ''));
      return;
    }
    const upstream = request({ hostname: target.hostname, port: target.port, path, method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on('error', (err) => { res.statusCode = 502; res.end(String(err)); });
    req.pipe(upstream);
  };

  const tls = createHttpsServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, serve);
  const proxy = createHttpServer(serve);
  proxy.on('connect', (_req, socket, head) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    tls.emit('connection', socket);
  });
  proxy.on('error', (err) => { throw new Error(`The local site could not listen on 127.0.0.1:${port}: ${err.message}`); });
  proxy.listen(port, '127.0.0.1');
  proxy.unref();
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The built-in page. Self-contained: anything else it loaded would not come through the tunnel. */
export function localSitePage(userAgent: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mobilewright × Sauce Connect</title>
<style>
  :root { --bg: #0b1a1f; --panel: #12282f; --line: #1f3d46; --text: #e8f1f2; --muted: #8fa9ae; --green: #3ddc91; --orange: #f6823b; }
  * { box-sizing: border-box; margin: 0; }
  body { min-height: 100vh; background: radial-gradient(circle at 20% 0%, #15403a 0%, transparent 55%), radial-gradient(circle at 100% 100%, #3a2416 0%, transparent 50%), var(--bg);
    color: var(--text); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 32px 20px; display: flex; flex-direction: column; align-items: center; }
  main { width: 100%; max-width: 440px; }
  .badge { display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; font-size: 13px; color: var(--muted); background: #0f2228; }
  .badge i { width: 8px; height: 8px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 0 var(--green); animation: pulse 1.6s infinite; }
  h1 { font-size: 34px; line-height: 1.15; margin: 20px 0 10px; letter-spacing: -0.02em; }
  h1 span { color: var(--green); }
  p.lead { color: var(--muted); }
  .flow { margin: 28px 0; padding: 20px; border: 1px solid var(--line); border-radius: 16px; background: var(--panel); }
  .node { display: flex; align-items: center; gap: 14px; }
  .icon { flex: none; width: 44px; height: 44px; border-radius: 12px; display: grid; place-items: center; font-size: 22px; background: #0b1a1f; border: 1px solid var(--line); }
  .node b { display: block; font-size: 15px; }
  .node small { color: var(--muted); font-size: 13px; }
  .pipe { position: relative; width: 2px; height: 34px; margin: 6px 0 6px 21px; background: var(--line); overflow: hidden; }
  .pipe::after { content: ""; position: absolute; left: 0; width: 2px; height: 12px; background: var(--green); animation: flow 1.2s linear infinite; }
  .pipe.two::after { background: var(--orange); animation-delay: .6s; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 13px; }
  dt { color: var(--muted); }
  dd { word-break: break-word; font-family: ui-monospace, Menlo, monospace; }
  footer { margin-top: 28px; color: var(--muted); font-size: 12px; text-align: center; }
  @keyframes pulse { 70% { box-shadow: 0 0 0 8px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
  @keyframes flow { from { top: -12px; } to { top: 34px; } }
</style>
</head>
<body>
<main>
  <div class="badge"><i></i>Tunnel up</div>
  <h1>${escapeHtml(LOCAL_SITE_TEXT)}</h1>
  <p class="lead">This page runs on your machine. A <span style="color:var(--green)">Sauce Labs</span> real device opened it through <b>Sauce Connect</b>, driven by <b>Mobilewright</b>.</p>
  <section class="flow">
    <div class="node"><div class="icon">💻</div><div><b>Your machine</b><small>${LOCAL_SITE_HOST}</small></div></div>
    <div class="pipe"></div>
    <div class="node"><div class="icon">🔒</div><div><b>Sauce Connect</b><small>Secure tunnel</small></div></div>
    <div class="pipe two"></div>
    <div class="node"><div class="icon">📱</div><div><b>Real device</b><small>Sauce Labs cloud</small></div></div>
  </section>
  <dl>
    <dt>Served at</dt><dd>${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC</dd>
    <dt>Browser</dt><dd>${escapeHtml(userAgent) || '—'}</dd>
  </dl>
  <footer>@saucelabs/mobilewright-driver · e2e</footer>
</main>
</body>
</html>`;
}
