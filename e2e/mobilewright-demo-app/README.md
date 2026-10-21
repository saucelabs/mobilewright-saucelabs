# Example: Mobilewright Playground app

A complete Mobilewright project that tests [Playground][playground], the app Mobilewright's own tests use, on Sauce Labs
real Android and iOS devices with `@saucelabs/mobilewright-driver`. It also runs as part of this repository's CI.

It shows how to:

- set the driver and install the app from a URL in [`mobilewright.config.ts`](mobilewright.config.ts);
- fill and clear text fields, and use toggles, steppers and buttons
  ([`tests/basic-ui.test.ts`](tests/basic-ui.test.ts));
- answer alerts and permission prompts with `screen.on('dialog')` ([`tests/dialogs.test.ts`](tests/dialogs.test.ts));
- use locators and assertions inside a web view ([`tests/webview.test.ts`](tests/webview.test.ts), Android).

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
tests with your own.

## Options

| Variable | Default | |
|---|---|---|
| `SAUCE_REGION` | `us-west-1` | Sauce Labs data center |
| `E2E_WORKERS` | `1` | Devices in parallel; up to your account's concurrency |
| `PLAYGROUND_APK`, `PLAYGROUND_IPA` | the app's GitHub release | Another build: a URL, a local path or a `storage:` ref |

Playground's iOS build needs iOS 18.6 or later. Its iOS web view isn't inspectable, so the web view test runs on
Android only.

[playground]: https://github.com/mobile-next/playground
[credentials]: https://docs.saucelabs.com/basics/acct-team-mgmt/managing-user-info/
