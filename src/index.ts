import { SauceLabsDriver, type SauceLabsDriverOptions } from './driver.js';

export { SauceLabsDriver, SessionTerminatedError, type SauceLabsDriverOptions } from './driver.js';
export type { SauceConnectOptions } from './sauce-connect.js';
export { RestClient, SauceApiError, type Region } from './rest-client.js';

/**
 * Config-file entry point — the driver instance mobilewright expects:
 *
 *   import { defineConfig } from 'mobilewright';
 *   import { sauceLabsDriver } from '@saucelabs/mobilewright-driver';
 *
 *   export default defineConfig({
 *     driver: sauceLabsDriver({ region: 'eu-central-1' }),
 *     projects: [{ name: 'android', use: { platform: 'android', deviceName: /Pixel/ } }],
 *   });
 *
 * Equivalent to `new SauceLabsDriver(options)`. Credentials fall back to
 * SAUCE_USERNAME / SAUCE_ACCESS_KEY.
 */
export function sauceLabsDriver(options?: SauceLabsDriverOptions): SauceLabsDriver {
  return new SauceLabsDriver(options);
}
