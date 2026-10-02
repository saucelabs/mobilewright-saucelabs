import { defineConfig } from 'mobilewright';
import { sauceLabsDriver, type Region } from '@saucelabs/mobilewright-driver';
import { localSiteTunnelOptions, sauceConnectEnabled } from './local-site';

/**
 * Sauce Labs demo app ("My Demo App") on Sauce Labs real devices:
 *   SAUCE_USERNAME=… SAUCE_ACCESS_KEY=… npm test -- --project android
 *
 * installApps takes the apps straight from their GitHub releases (Sauce Labs downloads them). Override with
 * SAUCE_DEMO_APK / SAUCE_DEMO_IPA (a URL, a local path or a storage: ref).
 */
const APK = process.env['SAUCE_DEMO_APK']
  ?? 'https://github.com/saucelabs/my-demo-app-android/releases/download/2.3.0/mda-2.3.0-27.apk';
const IPA = process.env['SAUCE_DEMO_IPA']
  ?? 'https://github.com/saucelabs/my-demo-app-ios/releases/download/2.3.0/SauceLabs-Demo-App.ipa';

export default defineConfig({
  testDir: './tests',
  // Device allocation (and the free tier's one-device-at-a-time limit) can take a while.
  timeout: 240_000,
  retries: 0,
  // One device at a time fits every Sauce Labs plan; raise it with E2E_WORKERS.
  workers: Number(process.env['E2E_WORKERS'] ?? 1),
  // Mobilewright's 5s defaults suit local devices. 30s gives locators and expect() room to check a remote
  // device's screen several times, as handling a dialog while an action or expect() waits needs.
  use: { actionTimeout: 30_000 },
  expect: { timeout: 30_000 },
  driver: sauceLabsDriver({
    region: (process.env['SAUCE_REGION'] as Region | undefined) ?? 'us-west-1',
    build: `mobilewright-saucelabs e2e (sauce-demo-app) ${process.env['GITHUB_RUN_ID'] ?? 'local'}`,
    tags: ['e2e', 'sauce-demo-app'],
    // A tunnel for the Sauce Connect test (see local-site.ts).
    sauceConnect: sauceConnectEnabled,
    sauceConnectOpts: sauceConnectEnabled ? localSiteTunnelOptions() : undefined,
  }),
  projects: [
    {
      name: 'android',
      // Foldables can launch apps onto the hidden display; the driver needs Android 13 or later.
      use: { platform: 'android', installApps: APK, deviceName: /Google_Pixel(?!.*Fold)/, osVersion: '>=13', bundleId: 'com.saucelabs.mydemoapp.android' },
    },
    {
      name: 'ios',
      // The demo app's iOS build requires iOS 16.6 or later.
      use: { platform: 'ios', installApps: IPA, deviceName: /iPhone/, osVersion: '>=16.6', bundleId: 'com.saucelabs.mydemo.app.ios' },
    },
  ],
  reporter: [['list'], ['html', { outputFolder: 'mobilewright-report', open: 'never' }]],
});
