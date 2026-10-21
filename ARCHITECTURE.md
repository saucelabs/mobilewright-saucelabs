# Architecture

How `@saucelabs/mobilewright-driver` works, and why it works that way. For using the driver, see the
[README](README.md); for working on it, [AGENTS.md](AGENTS.md).

## What it is

A [Mobilewright][mobilewright] driver: an object implementing
`MobilewrightDriver` from `@mobilewright/protocol`. Mobilewright's test runner, locators and assertions stay
unchanged; the driver turns their requests (allocate a device, read the screen, tap, launch an app, …) into
calls to the Sauce Labs [Real Device Access API][access-api-guide]
(v2, `https://api.<region>.saucelabs.com/rdc/v2`).

The protocol has two halves, and `SauceLabsDriver` (`src/driver.ts`) implements both:

- **`DeviceAllocator`** (`prepare()`, `allocate()`, `release()`, `dispose()`), called by Mobilewright's device pool
  in the runner process.
- **`MobilewrightSession`** (`connect()`, `disconnect()` and every device command), called in each test worker.

## Components

| File | Role |
|---|---|
| `src/index.ts` | Entry point: `sauceLabsDriver(options)` factory, `SauceLabsDriver`, `RestClient`, `SauceApiError` |
| `src/driver.ts` | The driver: device pool, session lifecycle, every protocol command, test reporting |
| `src/rest-client.ts` | Access API REST calls, Sauce Storage (upload, SHA-256 lookup, metadata), the HTTP proxy to the device, hosted Appium; typed `SauceApiError`; retries |
| `src/device-control-socket.ts` | The session's device-control WebSocket (`ioWebsocketUrl`): touches and keys |
| `src/companion-socket.ts` | The session's events WebSocket (`eventsWebsocketUrl`): device events and log lines |
| `src/wda-client.ts` | iOS: WebDriverAgent through the Access API's HTTP proxy (source, active app, keys, clear, alerts, orientation) |
| `src/webview.ts` | Webviews through the Appium server Sauce Labs hosts next to the device |
| `src/sauce-connect.ts` | Downloads, starts and stops Sauce Connect (`sauceConnect: true`) |
| `src/xml.ts` | XML parsing shared by the Android (uiautomator) and iOS (WDA) hierarchies |
| `src/websocket.ts` | Opening and closing the session's WebSockets, with time limits |
| `src/util.ts` | Small helpers: `sleep`, the Basic auth header, the Sauce Labs host check, log redaction |
| `src/plist.ts` | Reads a string from a binary or XML plist (an IPA's bundle id) |
| `src/playwright-test-info.ts` | The running Playwright test (title path, retry, status), for test reporting |

## Device pool: `allocate()` and `release()`

Mobilewright's runner holds a device pool with one slot per worker. To fill a slot it calls `allocate(criteria)`:

1. **Device query.** `deviceName` (a regex) is sent as `.*(?:<pattern>).*`, because Sauce Labs matches the whole
   device id or name while Mobilewright users expect "contained in". Sauce Labs can't filter by OS version, so
   with `osVersion` the driver lists the account's devices (`GET /devices`), keeps those that satisfy the
   expression, and sends their exact ids. `deviceType` can only be `real`.
2. **Apps first.** Local `installApps` files are uploaded to [Sauce Storage][app-storage] (or found there by SHA-256)
   before any session exists, so no device sits idle during an upload.
3. **Session.** `POST /sessions`, then poll until `ACTIVE`. When the account's [concurrency][managing-concurrency] is
   used up (409) or every matching device is busy (400 with `unavailableDevices`), the driver throws
   `NoDeviceAvailableError` so the pool re-queues the worker. The pool only retries a re-queued worker when one of its
   own slots frees up, which never happens if the devices are held outside the run, so in that case (`poolSessions`
   empty) the driver retries itself with backoff (5s doubling to 60s, ±20% jitter) until the pool's abort signal fires.
   A session that ends `ERRORED` while starting is replaced once, so one bad start doesn't fail the allocation (it isn't
   deleted: the API keeps `ERRORED` sessions, and they hold no device).
4. **Install.** The criteria's `installApps` are installed on the new session (`storage:` refs and `http(s)` URLs
   as given: Sauce Labs downloads URLs itself). They're returned in `installedApps`, so the test fixture doesn't
   install them again under its 60s `installTimeout`; here they run under the allocation timeout instead. A failed
   install deletes the session and fails the allocation.
5. **Result.** The Sauce session id is the pool's `deviceId`.

`release(deviceId)` deletes the session.

## Sauce Connect: `prepare()` and `dispose()`

With `sauceConnect: true`, the device pool's `prepare()` (once, before any test) starts a
[Sauce Connect 5][sauce-connect-5] tunnel, and `dispose()` (once, after the pool has released its devices) stops it. A
session created without `prepare()` (direct `connect()`) starts it first. Every `POST /sessions` names the tunnel in
`configuration.tunnel`; with `tunnelName` instead, sessions use a tunnel started outside the driver.

`src/sauce-connect.ts` follows node-saucelabs' `startSauceConnect`, with these differences:

- **Download:** the archive comes from the URL Sauce Labs' [download endpoint][sauce-connect-api] gives for the OS, CPU
  and version. Its SHA-256 is checked against the published one, and the binary is cached per version. It's extracted
  into a temporary folder that's renamed into place, so an interrupted download never looks complete.
- **Start:** `sc run` gets the credentials through its environment (command-line arguments show in `ps`), a free local
  port for its API, `runner=mobilewright-driver` metadata, and `*.apple.com` kept out of [TLS re-signing][tls-resigning]
  (added to `tlsPassthroughDomains`, or excluded from `tlsResignDomains` when that's given). iOS checks a test app's
  signing with Apple before opening it; re-signed, the check fails and the app shows "Unable to Verify App" (iOS 18 and
  26). The driver waits for `/readyz`, for up to 120s; when sc exits first, the error includes its last output lines.
- **Stop:** SIGINT, so sc closes the tunnel at Sauce Labs, then SIGKILL after 10s. On SIGINT/SIGTERM, the
  driver stops the tunnel after deleting the sessions that use it. On a plain process exit it sends SIGINT
  without waiting, and sc finishes on its own.

Devices don't send `localhost` or `127.0.0.1` through the tunnel (Chrome and Safari connect to the device itself), so
the integration and e2e tests use a made-up host, `mobilewright.test`: only it goes through the tunnel
([`tunnelDomains`](https://docs.saucelabs.com/dev/cli/sauce-connect-5/run/#tunnel-domains)), and sc hands it to a server
in the test as its [upstream proxy][proxies] (`proxy`), so nothing has to resolve the name. The demo app's Android web
view doesn't trust sc's re-signed certificate and blocks plain HTTP, so the e2e test opens the page in Chrome on
Android, and in the app on iOS.

A session whose tunnel can't be used ends `ERRORED` with Sauce Labs' reason. Those sessions aren't replaced,
since a new one fails the same way.

## Session lifecycle: `connect()` and `disconnect()`

Each test's worker calls `connect({ deviceId })` with the pooled session id and attaches to it. Without a
`deviceId` (direct use, no pool), `connect()` creates its own session and owns it.

`connect()`:

1. Waits until the session is `ACTIVE` and reads its links (sockets, live view).
2. Screen metrics from the device catalog: resolution, `pixelsPerPoint`, default orientation. On Android the
   real display size comes from `dumpsys window displays` (display 0), because many devices run below the panel
   resolution the catalog lists (a Pixel 9 Pro XL: 1344×2922 listed, 1008×2244 actual) and element bounds are in
   the real size.
3. Opens the [device-control][device-control-socket] and [companion][companion-socket] WebSockets (retrying a 5xx
   handshake).
4. On iOS, creates a `WdaClient` (it connects lazily, on first use).
5. Starts a Sauce Labs test for test reporting (below).

`disconnect()` ends the reported test, closes the hosted Appium session (if webviews were used) and the WDA
session, closes both sockets, and deletes the Sauce session only if `connect()` created it. A pooled session
stays up for the worker's next test.

## Device commands: which channel does what

The Access API gives several channels; each command uses the one that works (and is
[allowed on public devices][private-only]).

| Command | Android | iOS |
|---|---|---|
| View hierarchy | `uiautomator dump /dev/tty` via `executeShellCommand` | WDA `GET /source` (XML) |
| Tap, long press, swipe, gesture | Device-control socket (`mt/` touches) | Same |
| Type text | Socket keys (ASCII), `input text` otherwise | WDA `wda/keys` |
| Clear text | `input keycombination` Ctrl+A, then `input keyevent` DEL (Android 13+) | WDA element clear on the focused field |
| Hardware buttons | `input keyevent` | WDA `pressButton` |
| Launch app | REST `launchApp` with the launcher activity (resolved via `cmd package resolve-activity`, cached) | REST `launchApp` |
| Terminate app | `am force-stop` | WDA `apps/terminate` (after dismissing an open alert) |
| Install / uninstall | REST `installApp` (polled until `FINISHED`) / `uninstallApp` | Same |
| Clear app data | `pm clear` | Uninstall + reinstall (below) |
| Foreground app, app list | `dumpsys window`, `pm list packages -3` | WDA `activeAppInfo`, `apps/list` |
| Orientation | Read: `dumpsys window displays`; set: REST `applySettings` | Read: WDA; set: REST `applySettings` |
| Screenshot | REST `takeScreenshot` | Same |
| Video | Recorded by Sauce Labs for each reported test, linked from the report | Same |
| Webviews | Hosted Appium (below) | Same |

Coordinates: Android bounds are in pixels; iOS (WDA) bounds are in points, so touches are scaled by
`pixelsPerPoint`. The touch canvas swaps width and height in landscape.

## Why things are the way they are

Each of these came from a failure on a real device; the commit history has the details.

**iOS uses the WebDriverAgent already running on the device.** [Public devices][public-returns] reject launching one
(`launchWebDriverAgent` → 403), but the one on the device answers through the API's HTTP proxy. The driver
tries it first; only a configured custom WDA (`iosWdaStorageRef`, `iosWdaBundleId`), or no answer, makes it
upload and launch its own (private devices only).

**The WDA session follows the app in front.** A WDA session is tied to the app that was in front when it opened. When
that app has closed since, a command answers "stale element reference" for the application; the driver then opens a
new session, which follows the app in front now, and repeats the command once. To find the app in front it asks
`wda/activeAppInfo`, and falls back to `wda/apps/list` when WDA can't describe that app (a 500).

**Taps are held 100ms.** Touch-down and touch-up sent back to back can reach the device together; an iOS switch
ignores that (on iOS 18 and 26 an instant tap never flipped it, a 50ms hold always did).

**Text field `value` is worked out by the driver.** Both platforms report an empty field's hint/placeholder as
its text. With a known hint (Android 16+'s `hint` attribute, iOS `placeholderValue`), a field showing it reads
as `''`; otherwise a field reads as `''` after the driver clears it, until the next typing or tap
(`ActiveSession.textInput`). A field never touched may still report its hint on Android 13–15. On iOS the cleared
field is found by position: WDA's rect of it can differ from the page source's by a few points, so it matches when
each rect's center lies inside the other.

**iOS typing waits for the screen to settle.** Typing can briefly move the layout (on iOS 27 an alert's field and
buttons jump while the keyboard re-appears), and a page source read in that moment has positions that are gone a
second later. Mobilewright re-reads the screen right after typing to find a prompt's OK button, so `typeText()` returns
only when two reads of the focused element's rect agree (up to 3s).

**Android `fill()` needs Android 13.** The socket only sends single keys (no select-all), and
`input keycombination` arrived in API 33. Older devices fail with a clear error instead of silently not clearing.
The clear starts with `KEYCODE_MOVE_END`, which makes the keyboard finish the word being typed: while a word is open
(its suggestions showing), Gboard ignores select-all.

**iOS waits for focus after a tap.** Focus can land a moment after the tap that gives it (iOS 27), so the driver looks
for the focused element (`element/active`, then `hasKeyboardFocus`) for up to 3s before `fill()` gives up.

**iOS element visibility comes from the frame,** not WDA's `visible` attribute, which marks some on-screen
SwiftUI elements invisible. An element on screen with a size counts as visible.

**iOS `clearAppData()` reinstalls the app.** A real iOS device has no way to clear an app's data: WDA can only
reset some permissions (not location), and the Access API's file endpoints can't remove the sandbox's
Preferences or Caches. So the driver uninstalls the app and reinstalls it from the Storage file or URL this
session last installed it from (`listAppInstallations` lists the newest first). Finding that installation needs
each one's bundle id: Sauce Storage records it for stored files; for a URL the driver downloads the IPA, only
then, and reads its `Info.plist` (`src/plist.ts`). Keychain items survive, as with any reinstall. An app the
session didn't install (through `installApps`) can't be cleared. On Android, `pm clear` also resets the app's runtime
permissions.

**Open alerts are closed before terminating or reinstalling on iOS.** With an app's permission prompt still up,
terminating or uninstalling it leaves the device unable to bring the app back to the foreground (the app
switcher stays up), which failed every later test on that device.

**Empty Android dumps are retried.** `uiautomator dump` fails ("could not get idle state", or prints nothing)
while the screen animates. Returned as an empty tree, a locator would think its element is gone and
`scrollIntoViewIfNeeded()` would swipe, animating the screen again. The driver retries up to 3 times, 500ms
apart.

**Gateway and network errors are retried.** A 502/503 from the gateway means the request didn't reach the
device, so REST calls and WebSocket handshakes retry it twice (after 1s and 3s). A 504 means a request to the
device or Appium ran past 60s: the request got through and may still be running, so, like network errors, it's
retried for GET and DELETE only. Repeating a POST could open a second session, or queue a second Appium command
behind one that hangs.
A request that never connected (connect timeout, refused, DNS failure) was never sent, so it's retried for
every method, 4 times over ~34s: a short network interruption doesn't fail a test.

**Apps install during allocation, and URLs aren't downloaded locally.** Mobilewright passes `installApps` entries with a
URI scheme to the driver as given. The Access API's `installApp` takes `http(s)` URLs and downloads them itself,
[re-signing iOS apps][ios-app-resigning]; installing during `allocate()` gives large apps the allocation timeout instead
of the test's 60s `installTimeout`.

**Android launches need the launcher activity.** The REST `launchApp` rejects a package without an activity,
despite its spec. `cmd package resolve-activity` finds it; `dumpsys package` is the fallback (it's on the
public-device [ADB allowlist][adb-allowlist]; `cmd package` isn't).

**Orientation is read from the device.** The companion socket sends no orientation events, so the driver asks
`dumpsys window displays` (Android) or WDA (iOS).

**Hardware buttons don't use the socket.** A socket HOME raced a following `launchApp`; `input keyevent` and WDA
apply in order.

**Sessions are never left holding a device.** Every session the driver opens is tracked until it's deleted. On
SIGINT or SIGTERM it deletes the ones still open, then stops its Sauce Connect tunnel (within 10s), so an
interrupted run doesn't keep devices until Sauce Labs times the sessions out. Session deletes are retried on
network errors, WebSocket closes give up after 5s, and the WDA and hosted Appium sessions are opened once even
under concurrent calls (an orphaned Appium session would hold Android's UI automation).

**Credentials stay private.** They're kept in JavaScript private fields, so printing or serializing the driver
doesn't show them; they're only sent to `https://*.saucelabs.com` (and to Sauce Connect through its
environment); and typed text is masked in debug logs.

## Webviews: hosted Appium

The Access API has no access to a webview's devtools socket. Sauce Labs can [host an Appium server][hosted-appium] next
to the device (`POST /sessions/{id}/appiumserver`), and its webview contexts give JavaScript, navigation, URL and title.
`webViewBridge` starts it on first use (a few seconds), creates an Appium session, switches contexts per command, and
closes it on `disconnect()`. The version is [pinned][appium-version] to `appium3-2026-07`, the one checked with Chrome
(Android) and Safari (iOS) pages. While that Appium session holds Android's UI automation connection, `uiautomator dump`
can come back empty; the driver then reads the hierarchy from Appium's page source.

On iOS, Safari pages need Web Inspector enabled on the device, and an app's web view must be inspectable
(`WKWebView.isInspectable = true`, required since iOS 16.4) for any tool to attach to it.

**Safari tabs in the background (iOS 18+).** Safari suspends a tab that isn't in front, often within seconds,
and Appium's switch into it never answers (the gateway gives up with a 504 after 60s). Appium runs a session's
commands one at a time, so every later command waits behind it, and the gateway allows 10 commands in flight
per session: the Appium session is lost for good. iOS 17 doesn't do this. So on iOS:

- `listWebViews()` reads URLs and titles with `mobile: getContexts`, without switching into any page.
- A switch that hasn't answered in 20s deletes the Appium session (that takes a moment). To recover, the driver tries
  once more on a fresh session while the page is still listed; if that doesn't answer either, it fails with a message
  about background tabs, and the next call starts a new session. A new Appium session switches only to contexts it has
  listed, so the driver lists them first.

On Android, Chrome is a single context (`WEBVIEW_chrome`), on whichever tab ChromeDriver attached to, which isn't
always the one in front.

## Test reporting

Each Mobilewright test becomes a test on the Sauce Labs [Test Results][access-api-test-results] page. `connect()` calls
`startTest` with the test's title path (from Playwright's `test.info()`), the build, tags and artifact toggles (video,
screenshots and device logs on by default); `disconnect()` calls `endTest` with passed/failed, or no result for a
skipped test. A 409 on `startTest` (a test still open from a crashed worker) ends that test and retries. Reporting
errors are only logged: they never fail a test. Because the test starts at `connect()`, its video includes
Mobilewright's app relaunch before the test's first step.

## Mobilewright behaviors the driver works around

- **The pool doesn't release an idle device for another platform.** In one run with both platforms, once every
  slot holds an idle device of one platform, the other platform's tests wait forever, whatever the number of
  workers. Not fixable in the driver; the README says to run one process per platform.
- **Default timeouts are 5s,** meant for local devices. The README recommends 30s, so locators and assertions can
  check a remote device's screen several times.
- **`scrollIntoViewIfNeeded()` counts a clipped element as in view** (Android reports the visible part of its
  bounds). Tests that tap elements at the screen edge should scroll them further in first.

## Tests

| Kind | Where | Runs against |
|---|---|---|
| Unit | `src/*.test.ts` (Playwright test runner) | Fakes: `createFakeRest`, a fake WDA client and fake sockets in `driver.test.ts`; a mock `fetch` in `rest-client.test.ts` |
| Integration | `src/integration.test.ts` | Real Sauce Labs devices, the driver called directly (`SAUCE_INTEGRATION=1`; variables in [AGENTS.md](AGENTS.md)) |
| End to end | `e2e/` (two npm projects) | Real devices through `mobilewright test`: Sauce Labs' demo app and Mobilewright's Playground app |

## References

- Sauce Labs: [Real Device Access API guide][access-api-guide] ·
  [API reference][access-api-reference] ·
  [OpenAPI spec][access-api-spec] ·
  [Companion socket][companion-socket] ·
  [ADB allowlist][adb-allowlist] ·
  [Public and private devices][public-private] ·
  [Hosted Appium][hosted-appium] ·
  [App Storage API][storage-api] ·
  [Sauce Connect 5][sauce-connect-5] ·
  [`sc run` flags](https://docs.saucelabs.com/dev/cli/sauce-connect-5/run/) ·
  [Sauce Connect API][sauce-connect-api] ·
  [Data centers][data-center-endpoints]
- Mobilewright source: the driver contract in `packages/protocol/src/driver.ts`, the reference cloud driver in
  `packages/driver-mobilenext/`, the device pool in `packages/mobilewright/src/device-pool/`.

[mobilewright]: https://github.com/mobile-next/mobilewright
[access-api-guide]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-introduction/
[app-storage]: https://docs.saucelabs.com/mobile-apps/app-storage/
[managing-concurrency]: https://docs.saucelabs.com/basics/acct-team-mgmt/concurrency/managing-concurrency/
[sauce-connect-5]: https://docs.saucelabs.com/secure-connections/sauce-connect-5/
[sauce-connect-api]: https://docs.saucelabs.com/dev/api/connect/
[tls-resigning]: https://docs.saucelabs.com/secure-connections/sauce-connect-5/guides/tls-resigning/
[proxies]: https://docs.saucelabs.com/secure-connections/sauce-connect-5/guides/proxies/
[device-control-socket]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-device-control-socket/
[companion-socket]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-mastering-companion-socket/
[private-only]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-public-and-private-devices/#capabilities
[public-returns]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-public-and-private-devices/#what-public-devices-return-instead
[ios-app-resigning]: https://docs.saucelabs.com/mobile-apps/features/ios-app-resigning/
[adb-allowlist]: https://docs.saucelabs.com/mobile-apps/mobile-faq/#im-encountering-errors-when-executing-adb-shell-commands-what-could-be-the-issue
[hosted-appium]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-sauce-hosted-appium/
[appium-version]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-sauce-hosted-appium/#choosing-an-appium-version
[access-api-test-results]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-test-results/
[access-api-reference]: https://docs.saucelabs.com/dev/api/real-device-access/
[access-api-spec]: https://docs.saucelabs.com/oas/real-device-access-api-spec.yaml
[public-private]: https://docs.saucelabs.com/mobile-apps/real-device-access-api/real-device-access-api-public-and-private-devices/
[storage-api]: https://docs.saucelabs.com/dev/api/storage/
[data-center-endpoints]: https://docs.saucelabs.com/basics/data-center-endpoints/
