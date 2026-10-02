import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import createDebug from 'debug';
import { readLimited, type Region } from './rest-client.js';
import { USER_AGENT, sleep } from './util.js';

// Adapted from node-saucelabs' startSauceConnect (https://github.com/saucelabs/node-saucelabs).

const debug = createDebug('mw:mobilewright-driver:sauce-connect');

/**
 * Options for `sc run`, camelCased (`proxyLocalhost` is `--proxy-localhost`). See
 * https://docs.saucelabs.com/dev/cli/sauce-connect-5/run/.
 */
export interface SauceConnectOptions {
  /** Default: `mobilewright-<random id>`. */
  tunnelName?: string;
  /** Sauce Connect version to download: `5` (the latest 5.x, default), `5.5` or `5.5.3`. */
  scVersion?: string;
  /** `allow` lets devices reach this machine's `localhost`. Sauce Connect's default is `deny`. */
  proxyLocalhost?: 'allow' | 'deny' | 'direct';
  /** Any other `sc run` flag. `true` is passed as `--flag`; a list as `--flag=a,b`. */
  [flag: string]: string | number | boolean | string[] | undefined;
}

const DEFAULT_VERSION = '5';
/** Flags the driver sets itself. */
const DRIVER_FLAGS = new Set(['username', 'accessKey', 'region', 'apiAddress']);
const READY_TIMEOUT_MS = 120_000;
const HEALTHCHECK_INTERVAL_MS = 1_000;
const CLOSE_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_ARCHIVE_BYTES = 500 * 1024 ** 2;
/** Lines of Sauce Connect output kept for error messages. */
const OUTPUT_LINES_KEPT = 20;

/** Tunnels started by this process and not stopped yet. */
const runningTunnels = new Set<SauceConnect>();
let exitHandlerInstalled = false;

/** A Sauce Connect process this driver started. https://docs.saucelabs.com/secure-connections/sauce-connect-5/ */
export class SauceConnect {
  private readonly output: string[] = [];
  private exitReason: string | undefined;

  private constructor(readonly tunnelName: string, private readonly child: ChildProcess) {
    const keep = (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        debug('%s', line);
        this.output.push(line);
        if (this.output.length > OUTPUT_LINES_KEPT) this.output.shift();
      }
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('error', (err) => { this.exitReason ??= err.message; });
    child.on('exit', (code, signal) => {
      this.exitReason ??= signal ? `signal ${signal}` : `exit code ${code}`;
      runningTunnels.delete(this);
      debug('Sauce Connect %s exited: %s', tunnelName, this.exitReason);
    });
  }

  /** Downloads Sauce Connect if needed, starts it, and resolves once the tunnel is ready. */
  static async start(params: {
    username: string;
    accessKey: string;
    region: Region;
    options?: SauceConnectOptions;
    cacheDir?: string;
    fetchFn?: typeof globalThis.fetch;
  }): Promise<SauceConnect> {
    const { scVersion = DEFAULT_VERSION, tunnelName = `mobilewright-${randomUUID()}`, ...flags } = params.options ?? {};
    if (/^[0-4](\.|$)/.test(scVersion)) throw new Error(`Sauce Connect ${scVersion} is not supported: use version 5 or later.`);
    const binary = await downloadSauceConnect(params.region, scVersion, params.cacheDir ?? defaultCacheDir(), params.fetchFn);
    const port = await freePort();
    const args = ['run', ...runFlags(flags), `--region=${params.region}`, `--tunnel-name=${tunnelName}`, `--api-address=127.0.0.1:${port}`];
    // Flag values can hold secrets (a proxy's password), so only the names are logged.
    debug('starting %s %s', binary, args.map((arg) => arg.split('=')[0]).join(' '));
    // Credentials go through the environment: command-line arguments are visible to other users in `ps`.
    const child = spawn(binary, args, {
      env: { ...process.env, SAUCE_USERNAME: params.username, SAUCE_ACCESS_KEY: params.accessKey },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The tunnel doesn't keep this process running: on exit, the exit handler stops it.
    child.unref();
    for (const stream of [child.stdout, child.stderr]) (stream as Socket | null)?.unref();
    const tunnel = new SauceConnect(tunnelName, child);
    runningTunnels.add(tunnel);
    installExitHandler();
    try {
      await tunnel.waitForReady(port);
    } catch (err) {
      await tunnel.stop();
      throw err;
    }
    debug('Sauce Connect tunnel %s is ready', tunnelName);
    return tunnel;
  }

  get running(): boolean {
    return this.exitReason === undefined;
  }

  /** Why the process ended, with its last output lines. */
  describeExit(): string {
    return `Sauce Connect tunnel "${this.tunnelName}" stopped (${this.exitReason ?? 'running'}). Last output:\n${this.output.join('\n')}`;
  }

  /** Asks Sauce Connect to close the tunnel, without waiting. */
  interrupt(): void {
    this.child.kill('SIGINT');
  }

  /** Stops the tunnel: SIGINT, so Sauce Connect closes it cleanly, then SIGKILL after 10s. */
  async stop(): Promise<void> {
    runningTunnels.delete(this);
    if (!this.running) return;
    const exited = new Promise<void>((resolve) => this.child.once('exit', () => resolve()));
    this.child.kill('SIGINT');
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), CLOSE_TIMEOUT_MS); });
    if (await Promise.race([exited.then(() => false), timedOut])) {
      debug('Sauce Connect %s did not stop in %dms, killing it', this.tunnelName, CLOSE_TIMEOUT_MS);
      this.child.kill('SIGKILL');
      await exited;
    }
    clearTimeout(timer);
  }

  private async waitForReady(port: number): Promise<void> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.running) throw new Error(`Sauce Connect could not start. ${this.describeExit()}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(HEALTHCHECK_INTERVAL_MS) });
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      await sleep(HEALTHCHECK_INTERVAL_MS);
    }
    throw new Error(`Sauce Connect was not ready after ${READY_TIMEOUT_MS / 1000}s. Last output:\n${this.output.join('\n')}`);
  }
}

/** Stops every tunnel this process started. */
export async function stopSauceConnectTunnels(): Promise<void> {
  await Promise.allSettled([...runningTunnels].map((tunnel) => tunnel.stop()));
}

/** On exit, asks running tunnels to close (they finish on their own): an exit handler can't wait. */
function installExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', () => {
    for (const tunnel of runningTunnels) tunnel.interrupt();
  });
}

/**
 * iOS checks a test app's signing with Apple before it opens it. Through a tunnel that re-signs TLS (sc's default),
 * that check fails and the app shows "Unable to Verify App" (iOS 18 and 26, 2026-10-20), so Apple's domains always
 * pass through untouched (https://docs.saucelabs.com/secure-connections/sauce-connect-5/guides/tls-resigning/).
 */
const APPLE_DOMAINS = '.*\\.apple\\.com';

/**
 * `{ proxyLocalhost: 'allow', verbose: true }` → `['--proxy-localhost=allow', '--verbose']`, plus the runner metadata
 * and Apple's domains kept out of TLS re-signing.
 */
export function runFlags(flags: Record<string, SauceConnectOptions[string]>): string[] {
  const args: string[] = [];
  let metadata = '';
  flags = { ...flags };
  // sc takes either list, not both: exclude Apple from the domains to re-sign, or add it to those passed through.
  if (flags['tlsResignDomains'] !== undefined) flags['tlsResignDomains'] = [flags['tlsResignDomains'], `-${APPLE_DOMAINS}`].flat().map(String);
  else flags['tlsPassthroughDomains'] = [flags['tlsPassthroughDomains'] ?? [], APPLE_DOMAINS].flat().map(String);
  for (const [name, value] of Object.entries(flags)) {
    if (value === undefined) continue;
    if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) throw new Error(`Invalid Sauce Connect option "${name}": use camelCase, e.g. proxyLocalhost.`);
    if (DRIVER_FLAGS.has(name)) throw new Error(`Sauce Connect option "${name}" is set by the driver.`);
    const flag = `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    const text = Array.isArray(value) ? value.join(',') : String(value);
    if (name === 'metadata') metadata = text;
    else args.push(value === true ? flag : `${flag}=${text}`);
  }
  // Tells Sauce Labs which runner started the tunnel.
  if (!metadata.includes('runner=')) metadata = [metadata, 'runner=mobilewright-driver'].filter(Boolean).join(',');
  args.push(`--metadata=${metadata}`);
  return args;
}

// ─── Download ────────────────────────────────────────────────────────────────

interface DownloadInfo {
  url: string;
  version: string;
  checksums?: Array<{ value: string; algorithm: string }>;
}

function platformName(): { os: string; arch: string; binary: string } {
  const os = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform as string];
  const arch = { arm64: 'arm64', x64: 'x86_64' }[process.arch as string];
  if (!os || !arch) throw new Error(`Sauce Connect is not available for ${process.platform} ${process.arch}`);
  return { os, arch, binary: os === 'windows' ? 'sauce-connect.exe' : 'sc' };
}

function defaultCacheDir(): string {
  const base = process.platform === 'win32'
    ? process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches')
      : process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache');
  return join(base, 'saucelabs-mobilewright-driver', 'sauce-connect');
}

/**
 * The path of the Sauce Connect binary for `version`, downloaded into `cacheDir` unless it's there already.
 * The archive's SHA-256 is checked against the one Sauce Labs publishes: https://docs.saucelabs.com/dev/api/connect/
 */
export async function downloadSauceConnect(
  region: Region,
  version: string,
  cacheDir: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const { os, arch, binary } = platformName();
  const query = new URLSearchParams({ os, arch, version });
  const infoUrl = `https://api.${region}.saucelabs.com/rest/v1/public/tunnels/sauce-connect/download?${query}`;
  const headers = { 'User-Agent': USER_AGENT };
  const infoResponse = await fetchFn(infoUrl, { headers, signal: AbortSignal.timeout(30_000) });
  const info = await infoResponse.json().catch(() => ({})) as { download?: DownloadInfo; error?: { message?: string } };
  if (!info.download) {
    throw new Error(`Cannot find Sauce Connect ${version} for ${os} ${arch}: ${info.error?.message ?? `HTTP ${infoResponse.status}`}`);
  }
  const { url, version: resolved } = info.download;
  // The version names a cache folder, and the URL is downloaded: neither may point elsewhere.
  if (!/^\d+(\.\d+)*$/.test(resolved) || !url.startsWith('https://')) {
    throw new Error(`Unexpected Sauce Connect download: version ${resolved}, URL ${url}`);
  }
  const sha256 = info.download.checksums?.find((c) => c.algorithm === 'sha256')?.value;
  if (!sha256) throw new Error(`Sauce Labs published no SHA-256 for Sauce Connect ${resolved}`);

  const dir = join(cacheDir, `${resolved}-${os}-${arch}`);
  const binaryPath = join(dir, binary);
  const marker = join(dir, 'archive.sha256');
  if (await readFile(marker, 'utf8').then((v) => v === sha256, () => false)) return binaryPath;

  debug('downloading Sauce Connect %s from %s', resolved, url);
  const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Failed to download Sauce Connect from ${url}: ${response.status} ${response.statusText}`);
  const archive = await readLimited(response, url, MAX_ARCHIVE_BYTES);
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== sha256) throw new Error(`Sauce Connect download ${url} has SHA-256 ${actual}, expected ${sha256}`);

  // Extracted into a temporary directory and renamed, so an interrupted download never looks complete.
  await mkdir(cacheDir, { recursive: true });
  const tmp = await mkdtemp(join(cacheDir, '.download-'));
  try {
    await extractBinary(archive, url, binary, tmp);
    await chmod(join(tmp, binary), 0o755);
    await writeFile(join(tmp, 'archive.sha256'), sha256);
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    // Another process may have installed the same version meanwhile.
    if (await readFile(marker, 'utf8').then((v) => v === sha256, () => false)) return binaryPath;
    throw err;
  }
  return binaryPath;
}

async function extractBinary(archive: Buffer, url: string, binary: string, dir: string): Promise<void> {
  if (url.endsWith('.zip')) {
    const { default: AdmZip } = await import('adm-zip');
    const entry = new AdmZip(archive).getEntry(binary);
    if (!entry) throw new Error(`${url} has no ${binary}`);
    await writeFile(join(dir, binary), entry.getData());
    return;
  }
  const archivePath = join(dir, 'archive.tar.gz');
  await writeFile(archivePath, archive);
  await new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', archivePath, '-C', dir, binary], { stdio: 'ignore' });
    tar.on('error', reject);
    tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Extracting ${binary} from ${url} failed (tar exit code ${code})`))));
  });
  await rm(archivePath);
}

/** A free local TCP port for Sauce Connect's API (readiness check). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('No free port'))));
    });
  });
}
