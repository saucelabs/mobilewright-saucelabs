# Working on this repository

`@saucelabs/mobilewright-driver`: a Mobilewright driver for Sauce Labs real devices. Read
[ARCHITECTURE.md](ARCHITECTURE.md) before changing driver behavior: it explains the flows and why many
non-obvious choices were made (most come from failures on real devices). User-facing behavior is documented
in [README.md](README.md); keep it in step with the code.

## Commands

```bash
npm install
npm run build          # tsc → dist/
npm run lint           # tsc --noEmit + eslint
npm test               # unit tests (Playwright test runner, src/*.test.ts), no credentials needed
```

Real devices (need `SAUCE_USERNAME` / `SAUCE_ACCESS_KEY`; they use device time and the account's concurrency):

```bash
# Integration tests: the driver called directly
SAUCE_INTEGRATION=1 SAUCE_PLATFORM=android npx playwright test src/integration.test.ts   # or ios; -g to pick tests

# End-to-end suites through `mobilewright test` (see e2e/README.md)
npm run build && npm link                      # once, in the root
cd e2e/sauce-demo-app && npm install && npm link @saucelabs/mobilewright-driver
npm run test:android                           # and test:ios
```

Integration test variables:

| Variable | Default | |
|---|---|---|
| `SAUCE_INTEGRATION` | — | `1` runs the suite; otherwise it's skipped |
| `SAUCE_USERNAME`, `SAUCE_ACCESS_KEY` | — | Credentials ([where to find them][managing-user-info]) |
| `SAUCE_PLATFORM` | `ios` | `ios` or `android` |
| `SAUCE_REGION` | `us-west-1` | `us-west-1`, `us-east-4`, `eu-central-1` or `asia-south-2` ([data centers][data-center-endpoints]) |
| `SAUCE_DEVICE_NAME` | a Pixel / an iPhone, no foldables or `_free` devices | Device name regex, matched anywhere in the name |
| `SAUCE_OS_VERSION` | `>=13` / `>=17` | OS version expression; the demo app needs iOS 16.6+, `fill()` Android 13+ |
| `SAUCE_TEST_APP` | Sauce Labs' demo app | App the suite installs (a URL, path or `storage:` ref); the `clearAppData` test needs the default |
| `SAUCE_IOS_WDA_STORAGE_REF` | — | A custom WebDriverAgent ([private devices][private-only] only) |

The e2e suites' variables (`E2E_WORKERS`, `SAUCE_REGION`, app overrides) are in [e2e/README.md](e2e/README.md).

## Rules

- **A change to device behavior isn't done until it works on a real device.** Unit tests use fakes and can't
  show how a device reacts. Reproduce with a short probe script against the built `dist/`, fix, then run the
  integration or e2e tests on both platforms.
- **A flaky device test: check the OS version first.** The default `SAUCE_OS_VERSION` picks any matching
  version, and behavior can differ between them (Safari tabs in the background: iOS 17 passes, iOS 18+ hangs).
  Pin it with `SAUCE_OS_VERSION=18` and compare versions before blaming test order.
- **e2e: one process per platform** (`--project android`, `--project ios`). Mixing platforms in one process stalls
  Mobilewright's device pool, whatever the number of workers: once every slot holds an idle device of one
  platform, tests for the other wait forever (seen with 1, 2 and 4 workers). To run several processes at once,
  give each its own copy of the suite folder (they share `test-results/`).
- **Stay within the account's Access API [concurrency][managing-concurrency]**: the sum of workers over everything
  running at once. `E2E_WORKERS` sets the e2e workers (default 1).
- **Always close Sauce Labs sessions.** Ctrl-C and SIGTERM make the driver delete its sessions, but `kill -9` or a crash
  leaves them open, holding devices: check
  [`GET /rdc/v2/sessions`](https://docs.saucelabs.com/dev/api/real-device-access/) and delete what you started. The same
  goes for Sauce Connect tunnels ([`GET /rest/v1/<username>/tunnels`](https://docs.saucelabs.com/dev/api/connect/), and
  any `sc run` process left).
- **[Sauce Connect][sauce-connect-5] on public devices** needs the account to allow it; otherwise sessions fail with
  "only allowed if Sauce Connect is enabled for Public Cloud", and the integration test only checks the tunnel itself.
  The Sauce demo e2e suite starts a tunnel too (`E2E_SAUCE_CONNECT=0` turns it off).
- **Pages through Sauce Connect:** devices don't send `localhost` or `127.0.0.1` through the tunnel, so tests use
  the made-up host `mobilewright.test`, served by the test as sc's upstream proxy (ARCHITECTURE.md explains why).
- **Rebuild before real-device runs:** the e2e suites use the linked `dist/`. Run
  `npm link @saucelabs/mobilewright-driver` again after any `npm install` in a suite.
- The e2e configs raise Mobilewright's 5s default timeouts (meant for local devices) to 30s, so locators and
  assertions can check a remote device's screen several times.

## Conventions

- TypeScript, ESM, Node ≥ 22.12. Match the surrounding code: comment density, naming, the `debug` namespaces
  (`mw:mobilewright-driver[:rest|:wda|:webview|:io|:companion|:sauce-connect]`).
- Comments explain why, often with the device and OS version where a behavior was seen.
- New driver behavior gets unit tests next to the existing ones (`src/driver.test.ts` has the fakes:
  `createFakeRest`, `createDriverWithSession`, `withoutRealSleeps`).
- When Mobilewright adds a required method to `MobilewrightSession`, implement it (or throw a clear "not
  supported"). The driver supports one Mobilewright version (pinned in `peerDependencies`, since releases
  often change the driver interface): move it and the dev dependencies to the new version together.

[managing-user-info]: https://docs.saucelabs.com/basics/acct-team-mgmt/managing-user-info/
[data-center-endpoints]: https://docs.saucelabs.com/basics/data-center-endpoints/
[private-only]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-public-and-private-devices/#capabilities
[managing-concurrency]: https://docs.saucelabs.com/basics/acct-team-mgmt/concurrency/managing-concurrency/
[sauce-connect-5]: https://docs.saucelabs.com/secure-connections/sauce-connect-5/

## Releasing

Releases go out through the **Publish** workflow (Actions → Publish → Run workflow, pick patch, minor or major). It
runs the unit tests, then [release-it][release-it] bumps `version`, commits
`Release vX.Y.Z` to `main`, tags `vX.Y.Z`, creates the GitHub release and publishes to npm with trusted publishing (no
npm token; configured on the package's npm settings for `publish.yml`). Don't publish by
hand. To check the steps without releasing: `npx release-it patch --dry-run`.

[release-it]: https://github.com/release-it/release-it
