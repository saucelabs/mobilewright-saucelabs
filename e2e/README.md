# End-to-end tests

Mobilewright test suites that run through `mobilewright test` (CLI, `@mobilewright/test` fixtures, device
pool) on Sauce Labs real devices, using this driver. Each suite is its own npm project:

| Directory | App | Tests |
|---|---|---|
| [`sauce-demo-app`](sauce-demo-app) | Sauce Labs' demo app, "My Demo App" ([Android][my-demo-app-android], [iOS][my-demo-app-ios]) | catalog, product details, add to cart, a site on this machine through Sauce Connect |
| [`mobilewright-demo-app`](mobilewright-demo-app) | [Playground][playground], the app Mobilewright's own e2e tests use | home screen, text fields (`fill`, `clear`), controls, web view |

Each project's `installApps` takes its app straight from the GitHub release: Sauce Labs downloads it when it
installs the app, nothing is downloaded locally.

## Setup

Build the driver, link it, and install each suite:

```bash
# in the repository root
npm install && npm run build
npm link

# in each suite
cd e2e/sauce-demo-app
npm install
npm link @saucelabs/mobilewright-driver
```

`npm link` points the suite at this repository, so `npm run build` in the root is all a driver change needs.
Run `npm link @saucelabs/mobilewright-driver` again after any `npm install` in a suite: npm removes links
that aren't in `package.json`.

The linked driver resolves its own dependencies (`@mobilewright/protocol`, …) from the repository root, not
from the suite. That's fine while both use the same version (0.0.66). With different versions, error classes
the device pool checks with `instanceof` (`NoDeviceAvailableError`) wouldn't match. For a setup that behaves
exactly like a published package, install a packed tarball instead:

```bash
# in the repository root
npm pack                                   # → saucelabs-mobilewright-driver-<version>.tgz
# in a suite
npm install ../../saucelabs-mobilewright-driver-<version>.tgz
```

## Running

```bash
export SAUCE_USERNAME=… SAUCE_ACCESS_KEY=…     # optional: SAUCE_REGION (default us-west-1)
npm run test:android
npm run test:ios
```

Run one platform per process: `npm test` (both platforms in one run) stalls Mobilewright's device pool (see the
main README).

Results also show up on the Sauce Labs [Test Results][viewing-test-results] page, under the build
`mobilewright-saucelabs e2e (…)`. Tests run one device at a time by default, which works on every plan, including the
free tier. To run in parallel, set `E2E_WORKERS` to your account's Access API [concurrency][managing-concurrency] (e.g.
`E2E_WORKERS=5`); both suites can run at the same time as long as their workers add up to no more than that.
`DEBUG=mw:mobilewright-driver*` shows what the driver does.

In CI (`CI` set, as on GitHub Actions), a failed test is retried once and the results are also written to
`results/junit.xml`, which the End-to-end workflow publishes on the run's summary page.

To test other builds of the apps, set `SAUCE_DEMO_APK` / `SAUCE_DEMO_IPA` (Sauce demo app) or `PLAYGROUND_APK` /
`PLAYGROUND_IPA` (Playground) to a URL, a local path or a `storage:` ref.

## Sauce Connect

The Sauce demo suite starts a [Sauce Connect][sauce-connect-5] tunnel and opens a site served from this machine: in the
app's web view on iOS, in Chrome on Android (the app's Android web view doesn't accept pages through the tunnel). The
site is a small built-in page at `https://mobilewright.test` (see [`local-site.ts`](sauce-demo-app/local-site.ts)); it
needs `openssl` for its certificate.

- To open your own local site instead:
  `E2E_LOCAL_SITE=http://localhost:3001 E2E_LOCAL_SITE_TEXT='Some text on the page'`.
- Your account must allow Sauce Connect with public devices. Without it, set `E2E_SAUCE_CONNECT=0`: no tunnel,
  and the test is skipped.

## Device requirements

The configs pick devices accordingly:

- **Android 13 or later** (`osVersion: '>=13'`): the driver's `clearText()` needs it, and fails with a clear
  message on older devices.
- **No foldables on Android**: apps there can launch onto the display that isn't shown.
- **iOS**: Sauce Labs' demo app needs iOS 16.6+, Playground needs iOS 18.6+. On older devices Sauce Labs only
  reports "the application … cannot be installed".

## Notes on the apps

- **Sauce demo app, Android:** only a product's *image* opens it; tapping its title does nothing.
- **Sauce demo app, iOS:** catalog prices are exposed as "Product Price" elements without the amount.
- **Playground, iOS:** its web view never sets `WKWebView.isInspectable`, so on iOS 16.4+ no tool can attach
  to it on a real device. The web view test is skipped on iOS. Safari pages do work, see the driver's
  integration tests.
- **Untouched text fields** report their hint as their value on Android 13–15 and on iOS (see the main
  README), so the text-field tests always `fill` before asserting a value.

[my-demo-app-android]: https://github.com/saucelabs/my-demo-app-android
[my-demo-app-ios]: https://github.com/saucelabs/my-demo-app-ios
[playground]: https://github.com/mobile-next/playground
[viewing-test-results]: https://docs.saucelabs.com/test-results/viewing-test-results/
[managing-concurrency]: https://docs.saucelabs.com/basics/acct-team-mgmt/concurrency/managing-concurrency/
[sauce-connect-5]: https://docs.saucelabs.com/secure-connections/sauce-connect-5/
