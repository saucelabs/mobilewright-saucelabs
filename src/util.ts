import { createRequire } from 'node:module';

const { name, version } = createRequire(import.meta.url)('../package.json') as { name: string; version: string };

/** `saucelabs-mobilewright-driver/<version>`: the package name made a valid User-Agent product token. */
export const USER_AGENT = `${name.replace(/^@/, '').replace('/', '-')}/${version}`;

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The `Authorization` header value for Sauce Labs credentials. */
export function basicAuth(username: string, accessKey: string): string {
  return `Basic ${Buffer.from(`${username}:${accessKey}`).toString('base64')}`;
}

/** True for an `https://` URL on saucelabs.com: the only place credentials are sent. */
export function isSauceLabsUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && (hostname === 'saucelabs.com' || hostname.endsWith('.saucelabs.com'));
  } catch {
    return false;
  }
}

/** Shows how long a text is instead of the text, for debug logs (typed text can be a password). */
export function redact(text: string): string {
  return `<${text.length} chars>`;
}
