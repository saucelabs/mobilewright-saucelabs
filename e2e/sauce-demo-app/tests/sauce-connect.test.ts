import { expect, test } from '@mobilewright/test';
import { LOCAL_SITE_TEXT, LOCAL_SITE_URL, sauceConnectEnabled } from '../local-site';

// The device opens a site served from this machine (local-site.ts), through the tunnel the config starts.
test.skip(!sauceConnectEnabled, 'E2E_SAUCE_CONNECT=0: no tunnel');

test('a site on this machine opens through Sauce Connect', async ({ screen, device, platform }) => {
  if (platform === 'ios') {
    // In the app's own web view.
    await screen.getByTestId('More-tab-item').tap();
    await screen.getByTestId('Webview-menu-item').tap();
    await screen.getByRole('textfield').fill(LOCAL_SITE_URL);
    await screen.getByText('Go To Site').tap();
  } else {
    // In Chrome: the Android app's web view trusts only the system's certificates, not the one Sauce Connect
    // re-signs pages with, and the app blocks plain HTTP (it targets Android 12).
    await device.openUrl(LOCAL_SITE_URL);
  }
  await expect(screen.getByText(LOCAL_SITE_TEXT).first()).toBeVisible();
  await screen.screenshot();
});
