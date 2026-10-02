import { defineConfig } from 'mobilewright';
import { sauceLabsDriver, type Region } from '@saucelabs/mobilewright-driver';

/**
 * Mobilewright's demo app (Playground, https://github.com/mobile-next/playground — the app Mobilewright's
 * own e2e tests use) on Sauce Labs real devices:
 *   SAUCE_USERNAME=… SAUCE_ACCESS_KEY=… npm test -- --project android
 *
 * installApps takes the apps straight from their GitHub release; override with PLAYGROUND_APK / PLAYGROUND_IPA
 * (a URL, a local path or a storage: ref).
 */
const VERSION = 'v1.0.7';
const APK = process.env['PLAYGROUND_APK']
  ?? `https://github.com/mobile-next/playground/releases/download/${VERSION}/Playground-${VERSION.slice(1)}.apk`;
const IPA = process.env['PLAYGROUND_IPA']
  ?? `https://github.com/mobile-next/playground/releases/download/${VERSION}/Playground-${VERSION.slice(1)}.ipa`;

export default defineConfig({
  testDir: './tests',
  timeout: 240_000,
  // CI retries a failed test once; locally a failure shows right away.
  retries: process.env['CI'] ? 1 : 0,
  workers: Number(process.env['E2E_WORKERS'] ?? 1),
  // Mobilewright's 5s defaults suit local devices. 30s gives locators and expect() room to check a remote
  // device's screen several times, as handling a dialog while an action or expect() waits needs.
  use: { actionTimeout: 30_000 },
  expect: { timeout: 30_000 },
  driver: sauceLabsDriver({
    region: (process.env['SAUCE_REGION'] as Region | undefined) ?? 'us-west-1',
    build: `mobilewright-saucelabs e2e (mobilewright-demo-app) ${process.env['GITHUB_RUN_ID'] ?? 'local'}`,
    tags: ['e2e', 'mobilewright-demo-app'],
  }),
  projects: [
    {
      name: 'android',
      // Foldables can launch apps onto the hidden display; the driver needs Android 13 or later. The patterns only match
      // device ids (display names have spaces), so free-trial devices (`_free` in the id) can be left out: some don't
      // trust Sauce Connect's certificate.
      use: { platform: 'android', installApps: APK, deviceName: /^Google_Pixel_(?!.*(Fold|_free))/, osVersion: '>=13', bundleId: 'com.mobilenext.playground' },
    },
    {
      name: 'ios',
      // Playground's iOS build requires iOS 18.6 or later.
      use: { platform: 'ios', installApps: IPA, deviceName: /^iPhone_(?!.*_free)/, osVersion: '>=18.6', bundleId: 'com.mobilenext.playground' },
    },
  ],
  reporter: [
    ['list'],
    ['html', { outputFolder: 'mobilewright-report', open: 'never' }],
    // Published on the workflow run's summary page.
    ...(process.env['CI'] ? [['junit', { outputFile: 'results/junit.xml' }] as const] : []),
  ],
});
