import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import AdmZip from 'adm-zip';
import { SauceConnect, downloadSauceConnect, runFlags } from './sauce-connect.js';
import { USER_AGENT } from './util.js';

/**
 * Stands in for `sc run`: records its arguments and credentials and how often it was started, serves /readyz, and exits
 * 0 on SIGINT. FAKE_SC_CREATE_FAILURES makes that many starts fail to create the tunnel with a 504.
 */
const FAKE_SC = `#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const args = process.argv.slice(2);
const starts = (fs.existsSync(process.env.FAKE_SC_RECORD) ? JSON.parse(fs.readFileSync(process.env.FAKE_SC_RECORD, 'utf8')).starts : 0) + 1;
fs.writeFileSync(process.env.FAKE_SC_RECORD, JSON.stringify({ args, starts, username: process.env.SAUCE_USERNAME, accessKey: process.env.SAUCE_ACCESS_KEY }));
if (process.env.FAKE_SC_FAIL) { console.log('level=ERROR msg="invalid credentials"'); process.exit(1); }
if (starts <= Number(process.env.FAKE_SC_CREATE_FAILURES ?? 0)) {
  console.log('level=ERROR msg="fatal error exiting" error="create tunnel: URL https://api.us-west-1.saucelabs.com/rest/v1/alice/tunnels - 504 (Gateway Timeout)"');
  process.exit(1);
}
const port = Number(args.find((a) => a.startsWith('--api-address=')).split(':').pop());
let ready = false;
setTimeout(() => { ready = true; }, 1500);
http.createServer((req, res) => { res.statusCode = ready && req.url === '/readyz' ? 200 : 503; res.end(); }).listen(port, '127.0.0.1');
process.on('SIGINT', () => { console.log('tunnel was shutdown gracefully'); process.exit(0); });
`;

const BINARY = process.platform === 'win32' ? 'sauce-connect.exe' : 'sc';
const ARCHIVE_URL = 'https://saucelabs.com/downloads/sauce-connect/5.9.9/sauce-connect-5.9.9_test.zip';

function fakeArchive(): Buffer {
  const zip = new AdmZip();
  zip.addFile('LICENSE', Buffer.from('license'));
  zip.addFile(BINARY, Buffer.from(FAKE_SC));
  return zip.toBuffer();
}

/** Serves the download info and the archive; `sha256` and `version` override what's published. */
function fakeFetch(archive: Buffer, opts: { sha256?: string; version?: string } = {}) {
  const requests: string[] = [];
  const userAgents: unknown[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    userAgents.push((init?.headers as Record<string, string> | undefined)?.['User-Agent']);
    if (url.includes('/tunnels/sauce-connect/download')) {
      if (new URL(url).searchParams.get('version') === '9') {
        return Response.json({ error: { code: 'version_not_found', message: 'Download not found matching version: 9.' } }, { status: 404 });
      }
      const value = opts.sha256 ?? createHash('sha256').update(archive).digest('hex');
      return Response.json({ download: { url: ARCHIVE_URL, version: opts.version ?? '5.9.9', checksums: [{ algorithm: 'sha256', value }] } });
    }
    if (url === ARCHIVE_URL) return new Response(archive);
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetchFn, requests, userAgents };
}

let cacheDir: string;
test.beforeEach(async () => { cacheDir = await mkdtemp(join(tmpdir(), 'sc-test-')); });
test.afterEach(async () => { await rm(cacheDir, { recursive: true, force: true }); });

test.describe('runFlags', () => {
  test('turns camelCase options into flags and adds the runner metadata', () => {
    expect(runFlags({ proxyLocalhost: 'allow', tunnelDomains: ['.*\\.internal', 'example.com'], verbose: true, tunnelPool: false, logLevel: undefined }))
      .toEqual(['--proxy-localhost=allow', '--tunnel-domains=.*\\.internal,example.com', '--verbose', '--tunnel-pool=false', '--tls-passthrough-domains=.*\\.apple\\.com', '--metadata=runner=mobilewright-driver']);
  });

  test('keeps Apple\'s domains out of TLS re-signing, whichever list is given', () => {
    expect(runFlags({})).toContain('--tls-passthrough-domains=.*\\.apple\\.com');
    expect(runFlags({ tlsPassthroughDomains: 'mobilewright\\.test' })).toContain('--tls-passthrough-domains=mobilewright\\.test,.*\\.apple\\.com');
    const resign = runFlags({ tlsResignDomains: ['.*\\.example\\.com'] });
    expect(resign).toContain('--tls-resign-domains=.*\\.example\\.com,-.*\\.apple\\.com');
    expect(resign.some((flag) => flag.startsWith('--tls-passthrough-domains'))).toBe(false);
  });

  test('keeps the given metadata, adding the runner unless it names one', () => {
    expect(runFlags({ metadata: 'build=42' })).toContain('--metadata=build=42,runner=mobilewright-driver');
    expect(runFlags({ metadata: 'runner=ci' })).toContain('--metadata=runner=ci');
  });

  test('rejects the flags the driver sets, and names that are not camelCase', () => {
    expect(() => runFlags({ accessKey: 'x' })).toThrow('set by the driver');
    expect(() => runFlags({ apiAddress: ':8032' })).toThrow('set by the driver');
    expect(() => runFlags({ 'proxy-localhost': 'allow' })).toThrow('camelCase');
  });
});

test.describe('downloadSauceConnect', () => {
  test('downloads, checks and caches the binary, and uses the cache next time', async () => {
    const { fetchFn, requests, userAgents } = fakeFetch(fakeArchive());

    const path = await downloadSauceConnect('eu-central-1', '5', cacheDir, fetchFn);
    const again = await downloadSauceConnect('eu-central-1', '5', cacheDir, fetchFn);

    expect(again).toBe(path);
    expect(await readFile(path, 'utf8')).toBe(FAKE_SC);
    expect(requests.filter((url) => url === ARCHIVE_URL)).toHaveLength(1);
    expect(userAgents.every((ua) => ua === USER_AGENT)).toBe(true);
    expect(requests[0]).toMatch(/^https:\/\/api\.eu-central-1\.saucelabs\.com\/rest\/v1\/public\/tunnels\/sauce-connect\/download\?os=\w+&arch=\w+&version=5$/);
  });

  test('rejects an archive whose checksum does not match, leaving nothing in the cache', async () => {
    const { fetchFn } = fakeFetch(fakeArchive(), { sha256: '0'.repeat(64) });

    await expect(downloadSauceConnect('us-west-1', '5', cacheDir, fetchFn)).rejects.toThrow('expected 0000');
    expect(await readdir(cacheDir).catch(() => [])).toEqual([]);
  });

  test('refuses a version that is not a version number, since it names the cache folder', async () => {
    const { fetchFn } = fakeFetch(fakeArchive(), { version: '../../elsewhere' });
    await expect(downloadSauceConnect('us-west-1', '5', cacheDir, fetchFn)).rejects.toThrow('Unexpected Sauce Connect download');
  });

  test('reports a version Sauce Labs does not have', async () => {
    const { fetchFn } = fakeFetch(fakeArchive());
    await expect(downloadSauceConnect('us-west-1', '9', cacheDir, fetchFn)).rejects.toThrow('Download not found matching version: 9.');
  });
});

test.describe('SauceConnect', () => {
  test.skip(process.platform === 'win32', 'the fake sc is a Node.js script');

  let record: string;
  test.beforeEach(() => {
    record = join(cacheDir, 'record.json');
    process.env['FAKE_SC_RECORD'] = record;
  });
  test.afterEach(() => {
    delete process.env['FAKE_SC_RECORD'];
    delete process.env['FAKE_SC_FAIL'];
    delete process.env['FAKE_SC_CREATE_FAILURES'];
  });
  const starts = async () => JSON.parse(await readFile(record, 'utf8')).starts as number;

  test('starts sc with the credentials in its environment, waits until ready, and stops it', async () => {
    const { fetchFn } = fakeFetch(fakeArchive());

    const tunnel = await SauceConnect.start({
      username: 'alice', accessKey: 'secret', region: 'us-west-1', cacheDir, fetchFn,
      options: { tunnelName: 'my-tunnel', proxyLocalhost: 'allow' },
    });

    expect(tunnel.running).toBe(true);
    expect(tunnel.tunnelName).toBe('my-tunnel');
    const { args, username, accessKey } = JSON.parse(await readFile(record, 'utf8'));
    expect({ username, accessKey }).toEqual({ username: 'alice', accessKey: 'secret' });
    expect(args).toEqual([
      'run', '--proxy-localhost=allow', '--tls-passthrough-domains=.*\\.apple\\.com', '--metadata=runner=mobilewright-driver', '--region=us-west-1',
      '--tunnel-name=my-tunnel', expect.stringMatching(/^--api-address=127\.0\.0\.1:\d+$/),
    ]);
    expect(JSON.stringify(args)).not.toContain('secret');

    await tunnel.stop();
    expect(tunnel.running).toBe(false);
    expect(tunnel.describeExit()).toContain('exit code 0');
  });

  test('refuses Sauce Connect 4, whose command line is different', async () => {
    const { fetchFn, requests } = fakeFetch(fakeArchive());
    await expect(SauceConnect.start({ username: 'alice', accessKey: 'secret', region: 'us-west-1', cacheDir, fetchFn, options: { scVersion: '4.9.2' } }))
      .rejects.toThrow('use version 5');
    expect(requests).toEqual([]);
  });

  test('generates a tunnel name when none is given', async () => {
    const { fetchFn } = fakeFetch(fakeArchive());
    const tunnel = await SauceConnect.start({ username: 'alice', accessKey: 'secret', region: 'us-west-1', cacheDir, fetchFn });
    await tunnel.stop();
    expect(tunnel.tunnelName).toMatch(/^mobilewright-[0-9a-f-]{36}$/);
  });

  test('fails with Sauce Connect output when it exits before it is ready', async () => {
    process.env['FAKE_SC_FAIL'] = '1';
    const { fetchFn } = fakeFetch(fakeArchive());

    await expect(SauceConnect.start({ username: 'alice', accessKey: 'wrong', region: 'us-west-1', cacheDir, fetchFn, retryDelaysMs: [0, 0] }))
      .rejects.toThrow(/could not start[\s\S]*exit code 1[\s\S]*invalid credentials/);
    // Not a server error, so not tried again.
    expect(await starts()).toBe(1);
  });

  test('starts again when creating the tunnel gets a server error, with the same tunnel name', async () => {
    process.env['FAKE_SC_CREATE_FAILURES'] = '2';
    const { fetchFn } = fakeFetch(fakeArchive());

    const tunnel = await SauceConnect.start({
      username: 'alice', accessKey: 'secret', region: 'us-west-1', cacheDir, fetchFn, retryDelaysMs: [0, 0], options: { tunnelName: 'my-tunnel' },
    });
    await tunnel.stop();

    expect(await starts()).toBe(3);
    expect(JSON.parse(await readFile(record, 'utf8')).args).toContain('--tunnel-name=my-tunnel');
  });

  test('gives up with Sauce Connect output when every try gets a server error', async () => {
    process.env['FAKE_SC_CREATE_FAILURES'] = '5';
    const { fetchFn } = fakeFetch(fakeArchive());

    await expect(SauceConnect.start({ username: 'alice', accessKey: 'secret', region: 'us-west-1', cacheDir, fetchFn, retryDelaysMs: [0, 0] }))
      .rejects.toThrow(/could not start[\s\S]*create tunnel:.*504/);
    expect(await starts()).toBe(3);
  });
});
