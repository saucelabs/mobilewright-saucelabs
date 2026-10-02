import { expect, test } from '@mobilewright/test';
import type { Screen } from 'mobilewright';

// Element ids differ per platform; the visible texts mostly don't.
// Android: resource ids (com.saucelabs.mydemoapp.android:id/…); iOS: accessibility identifiers.

/** The first product's image: on Android only the image opens a product, its title doesn't react to taps. */
const firstProductImage = (screen: Screen, platform: string | undefined) =>
  screen.getByTestId(platform === 'android' ? 'productIV' : 'Product Image').first();

test('the catalog lists the products', async ({ screen, platform }) => {
  await expect(screen.getByText(/Sauce Labs Backpack/).first()).toBeVisible();
  // iOS exposes the catalog prices only as "Product Price" elements, without the amount.
  const price = platform === 'android' ? screen.getByText('$ 29.99') : screen.getByTestId('Product Price');
  await expect(price.first()).toBeVisible();
});

test('a product opens its details with price and add-to-cart', async ({ screen, platform }) => {
  await firstProductImage(screen, platform).tap();

  await expect(screen.getByText('$ 29.99')).toBeVisible();
  const addToCart = screen.getByTestId(platform === 'android' ? 'cartBt' : 'AddToCart');
  await expect(addToCart).toBeVisible();
  await expect(addToCart).toBeEnabled();
  await screen.screenshot();
});

test('a product added to the cart shows up in the cart', async ({ screen, platform }) => {
  await firstProductImage(screen, platform).tap();
  await screen.getByTestId(platform === 'android' ? 'cartBt' : 'AddToCart').tap();

  await screen.getByTestId(platform === 'android' ? 'cartRL' : 'Cart-tab-item').tap();
  await expect(screen.getByText(/Sauce Labs Backpack/).first()).toBeVisible();
  await expect(screen.getByText(/Proceed To Checkout/i)).toBeVisible();
  await screen.screenshot();
});
