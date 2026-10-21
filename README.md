# @saucelabs/mobilewright-driver

Run your [Mobilewright][mobilewright] tests on Sauce Labs real Android and iOS devices. Add the driver to your config;
your tests don't change.

Requires `mobilewright` 0.0.67, Node.js 22.12 or later, and Android 13 or later on Android devices.

## Get started

1. Install the driver:

   ```bash
   npm i -D @saucelabs/mobilewright-driver
   ```

2. Set the driver in `mobilewright.config.ts`. This example runs [Sauce Labs' demo app][my-demo-app] on a Pixel and an
   iPhone:

   ```ts
   import { defineConfig } from 'mobilewright';
   import { sauceLabsDriver } from '@saucelabs/mobilewright-driver';

   export default defineConfig({
     testDir: './tests',
     use: { actionTimeout: 30_000 },
     expect: { timeout: 30_000 },
     driver: sauceLabsDriver({ region: 'us-west-1', build: 'my-first-build' }), // us-east-4, eu-central-1, asia-south-2
     projects: [
       {
         name: 'android',
         use: {
           platform: 'android',
           deviceName: /Google_Pixel(?!.*Fold)/, // no foldables: apps can open on the hidden screen
           osVersion: '>=13',
           bundleId: 'com.saucelabs.mydemoapp.android',
           installApps: 'https://github.com/saucelabs/my-demo-app-android/releases/download/2.3.0/mda-2.3.0-27.apk',
         },
       },
       {
         name: 'ios',
         use: {
           platform: 'ios',
           deviceName: /iPhone/,
           osVersion: '>=16.6',
           bundleId: 'com.saucelabs.mydemo.app.ios',
           installApps: 'https://github.com/saucelabs/my-demo-app-ios/releases/download/2.3.0/SauceLabs-Demo-App.ipa',
         },
       },
     ],
   });
   ```

3. Write a test, as you would for a local device:

   ```ts
   // tests/catalog.test.ts
   import { expect, test } from '@mobilewright/test';

   test('the catalog lists the backpack', async ({ screen }) => {
     await expect(screen.getByText(/Sauce Labs Backpack/).first()).toBeVisible();
   });
   ```

4. Run it with your [Sauce Labs credentials][credentials]:

   ```bash
   export SAUCE_USERNAME=… SAUCE_ACCESS_KEY=…
   npx mobilewright test --project android
   npx mobilewright test --project ios
   ```

Each test shows up on the Sauce Labs [Test Results][test-results] page with its video, screenshots and device logs.

## Examples

Two complete projects you can copy, both run in this repository's CI:

- [Sauce Labs demo app](e2e/sauce-demo-app): installing an app from a URL, tests for both platforms, and a site on your
  machine through Sauce Connect.
- [Mobilewright Playground app](e2e/mobilewright-demo-app): text fields, controls, alerts and permission prompts, and
  web views.

## Options

All options are optional.

| Option | Default | Description |
|---|---|---|
| `username`, `accessKey` | env vars | Sauce Labs credentials |
| `region` | `us-west-1` | [Data center][data-centers]: `us-west-1`, `us-east-4`, `eu-central-1` or `asia-south-2` |
| `build`, `tags` | — | Build name and tags shown on the Test Results page |
| `reportTests` | `true` | Report each test to the Test Results page |
| `artifacts` | video, screenshots, device logs | What Sauce Labs records per test: `{ video, screenshots, deviceLogs, networkCapture }` |
| `allocationTimeout` | `300000` | How long to wait for a device, in ms |
| `sessionDuration` | Sauce Labs' default | Maximum session length, e.g. `PT1H` ([limits][session-duration]) |
| `sauceConnect` | `false` | Start a [Sauce Connect][sauce-connect] tunnel for the run |
| `sauceConnectOpts` | — | Tunnel options: any [`sc run` flag][sc-run], camelCased (e.g. `tunnelDomains`) |
| `tunnelName`, `tunnelOwner` | — | Use a tunnel that's already running, or one [shared][sharing-tunnel] with you |
| `appiumVersion` | `appium3-2026-07` | [Hosted Appium][hosted-appium] version used for web views |
| `iosWdaStorageRef`, `iosWdaBundleId` | — | A custom WebDriverAgent (iOS, [private devices][public-private] only) |

## Tips

**Timeouts.** Mobilewright's 5-second defaults are meant for local devices. Use 30 seconds for `actionTimeout` and
`expect`, as in the example above.

**Parallel runs.** Each worker uses one device. Set `workers` to your account's [concurrency][concurrency] (the free
tier allows 1). Run Android and iOS in separate processes (`--project android`, `--project ios`): in one process,
Mobilewright's device pool can wait forever for the other platform.

**Apps.** `installApps` takes an `https://` URL (Sauce Labs downloads it), a file in [App Storage][app-storage]
(`storage:<id>` or `storage:filename=<name>`), or a local `.apk`, `.ipa` or `.zip` (uploaded once, then reused).

**Test results.** A retry shows up as `… (retry 1)`. To skip a test without leaving an empty job on Sauce Labs, skip it
before it starts: `test.skip(({ platform }) => platform === 'ios', 'reason')`. Each test in Playwright's HTML report
links to its Sauce Labs job, where the video is. Mobilewright's own `video` option records nothing on Sauce Labs.

**Local device or Sauce Labs.** Use Sauce Labs only when the credentials are set:

```ts
const config: MobilewrightConfig = { /* ... */ };
if (process.env.SAUCE_USERNAME) config.driver = sauceLabsDriver();
export default defineConfig(config);
```

## Sauce Connect

Use [Sauce Connect][sauce-connect] when your app talks to a server on your machine or on a private network. The driver
downloads it, starts the tunnel before the first test and stops it at the end:

```ts
driver: sauceLabsDriver({
  sauceConnect: true,
  sauceConnectOpts: { tunnelDomains: ['.*\\.internal'] }, // optional: only these hosts use the tunnel
}),
```

Good to know:

- Your organization must allow Sauce Connect on public devices.
- Devices don't send `localhost` or `127.0.0.1` through the tunnel. Use another name for your server, e.g.
  `localtest.me` with `proxyLocalhost: 'allow'` ([localhost proxying][localhost-proxying]).
- Sauce Connect [re-signs HTTPS][tls-resigning]. Chrome and Safari accept it; an Android app's web view may not. List
  such hosts in `tlsPassthroughDomains`.
- Safari on iOS 18 and later tries HTTPS first, even for `http://` URLs. For a plain HTTP server, list its host in
  `tlsPassthroughDomains`.

## Public and private devices

Both work. Public devices limit sessions to 1 hour, don't allow a custom WebDriverAgent, and may limit Android shell
commands to an [allowlist][adb-allowlist]. The driver needs `uiautomator dump`; if your account blocks it, use a
private device or ask Sauce Labs to allow it. See [public and private devices][public-private].

## Troubleshooting

- **See what the driver does:** `DEBUG=mw:mobilewright-driver*`. `SAUCE_LIVE_VIEW=1` prints a link to watch each device
  live.
- **"Failed to reach Sauce Connect tunnel":** the tunnel in `tunnelName` isn't running, or isn't shared with you (set
  `tunnelOwner`).
- **"The application at path … cannot be installed":** the device's OS is likely older than the app's minimum. Set
  `osVersion`, e.g. `'>=18.6'`.
- **Web views on iOS:** Safari needs Web Inspector on, and an app's web view must set `WKWebView.isInspectable = true`.

## Development

How the driver works: [ARCHITECTURE.md](ARCHITECTURE.md). How to work on it: [AGENTS.md](AGENTS.md).

```bash
npm install
npm run build
npm run lint
npm test   # unit tests, no credentials needed
```

## License

Apache-2.0

[mobilewright]: https://github.com/mobile-next/mobilewright
[my-demo-app]: https://github.com/saucelabs/my-demo-app-android
[credentials]: https://docs.saucelabs.com/basics/acct-team-mgmt/managing-user-info/
[test-results]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-test-results/
[data-centers]: https://docs.saucelabs.com/basics/data-center-endpoints/
[session-duration]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-public-and-private-devices/#session-duration
[sauce-connect]: https://docs.saucelabs.com/secure-connections/sauce-connect-5/
[sc-run]: https://docs.saucelabs.com/dev/cli/sauce-connect-5/run/
[sharing-tunnel]: https://docs.saucelabs.com/secure-connections/sauce-connect-5/guides/sharing-tunnel/
[hosted-appium]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-sauce-hosted-appium/
[public-private]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-public-and-private-devices/
[concurrency]: https://docs.saucelabs.com/basics/acct-team-mgmt/concurrency/managing-concurrency/
[app-storage]: https://docs.saucelabs.com/mobile-apps/app-storage/
[localhost-proxying]: https://docs.saucelabs.com/secure-connections/sauce-connect-5/guides/localhost-proxying/
[tls-resigning]: https://docs.saucelabs.com/secure-connections/sauce-connect-5/guides/tls-resigning/
[adb-allowlist]: https://docs.saucelabs.com/mobile-apps/mobile-faq/#im-encountering-errors-when-executing-adb-shell-commands-what-could-be-the-issue
