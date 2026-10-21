# Example: Sauce Labs demo app

A complete Mobilewright project that tests [Sauce Labs' demo app][my-demo-app] ("My Demo App") on Sauce Labs real
Android and iOS devices with `@saucelabs/mobilewright-driver`. It also runs as part of this repository's CI.

It shows how to:

- set the driver, the region and the build name in [`mobilewright.config.ts`](mobilewright.config.ts);
- install the app straight from a URL (`installApps`): Sauce Labs downloads it, nothing is uploaded;
- pick devices by name and OS version (`deviceName`, `osVersion`);
- write tests that work on both platforms ([`tests/catalog.test.ts`](tests/catalog.test.ts));
- open a site on your machine through a Sauce Connect tunnel
  ([`tests/sauce-connect.test.ts`](tests/sauce-connect.test.ts), served by [`local-site.ts`](local-site.ts)).

## Run it

Needs Node.js 22.12 or later and your [Sauce Labs credentials][credentials].

```bash
npm install
export SAUCE_USERNAME=… SAUCE_ACCESS_KEY=…
npm run test:android
npm run test:ios
```

Each test shows up on the Sauce Labs Test Results page, under the build `mobilewright-saucelabs e2e (…)`. Run Android
and iOS in separate commands, as above.

## Use it as a starting point

Copy this folder into your own project: its [`package.json`](package.json) has everything a project needs
(`mobilewright`, `@mobilewright/test` and `@saucelabs/mobilewright-driver`). Then replace the app URLs, bundle ids and
tests with your own. If you don't need Sauce Connect, remove `tests/sauce-connect.test.ts`, `local-site.ts` and the
`sauceConnect` options from the config.

## Options

| Variable | Default | |
|---|---|---|
| `SAUCE_REGION` | `us-west-1` | Sauce Labs data center |
| `E2E_WORKERS` | `1` | Devices in parallel; up to your account's concurrency |
| `SAUCE_DEMO_APK`, `SAUCE_DEMO_IPA` | the app's GitHub release | Another build: a URL, a local path or a `storage:` ref |
| `E2E_SAUCE_CONNECT` | on | `0` runs without a tunnel and skips the Sauce Connect test |
| `E2E_LOCAL_SITE`, `E2E_LOCAL_SITE_TEXT` | a built-in page | Open your own local site, and the text the test expects on it |

The Sauce Connect test needs `openssl` (for the local site's certificate) and an account that allows Sauce Connect on
public devices.

[my-demo-app]: https://github.com/saucelabs/my-demo-app-android
[credentials]: https://docs.saucelabs.com/basics/acct-team-mgmt/managing-user-info/
