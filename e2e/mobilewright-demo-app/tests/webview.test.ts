import { test } from '@mobilewright/test';
// Web view pages are asserted with Playwright's own expect, like Mobilewright's conformance tests do.
import { expect } from '@playwright/test';

// Same flow as Mobilewright's own conformance tests: open Playground's Web View screen and drive the page.
// The driver reaches webviews through the Appium server Sauce Labs hosts next to the device; it starts on
// first use, which takes a few seconds.

function pageWithBody(bodyHtml: string): string {
  return `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><body>${bodyHtml}</body>`)}`;
}

// Playground's iOS WKWebView doesn't set isInspectable, so since iOS 16.4 no tool can attach to it on a real device
// (Safari pages work: see the driver's integration tests). Skipped before the test starts, so no device connects.
test.skip(({ platform }) => platform === 'ios', 'Playground\'s iOS web view is not inspectable (WKWebView.isInspectable is unset)');

test('locators and assertions work inside the web view', async ({ screen }) => {
  await screen.getByText('Web View').tap();
  const page = await screen.getByWebView().page();

  await page.goto(pageWithBody(`
    <button>Sign in</button>
    <label>Email <input type="text" placeholder="you@example.com" data-testid="email"></label>
    <ul><li>one</li><li>two</li><li>three</li></ul>
  `));

  await expect(page.getByRole('button', { name: 'Sign in' })).toHaveCount(1);
  await expect(page.getByPlaceholder('you@example.com')).toHaveCount(1);
  await expect(page.getByTestId('email')).toHaveCount(1);
  await expect(page.locator('li')).toHaveCount(3);
  await expect(page.locator('li').nth(1)).toHaveText('two');
});
