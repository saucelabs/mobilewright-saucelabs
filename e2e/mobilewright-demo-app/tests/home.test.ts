import { expect, test } from '@mobilewright/test';

test('the home screen lists every demo', async ({ screen }) => {
  for (const demo of ['Basic UI', 'Web View', 'SharedPref / Keychain', 'Continuous Animation', 'Permissions and Alerts', 'GPS Location']) {
    await expect(screen.getByText(demo)).toBeVisible();
  }
  await screen.screenshot();
});
