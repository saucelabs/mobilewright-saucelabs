import { expect, test } from '@mobilewright/test';

test.beforeEach(async ({ screen }) => {
  await screen.getByText('Basic UI').tap();
  await expect(screen.getByTestId('text_field')).toBeVisible();
});

test('fill replaces a text field\'s content', async ({ screen }) => {
  const field = screen.getByTestId('text_field');
  await field.fill('hello');
  await expect(field).toHaveValue('hello');

  // fill() clears first, so nothing is appended.
  await field.fill('world');
  await expect(field).toHaveValue('world');
  await screen.screenshot();
});

test('text with spaces and special characters reads back exactly as typed', async ({ screen }) => {
  const field = screen.getByTestId('text_field');
  for (const text of ['to be removed', 'Tom & Jerry say "hi" <3', 'a+b=c (x_y) #1 @me ~/tmp']) {
    await field.fill(text);
    await expect(field).toHaveValue(text);
  }
});

test('clear empties a text field', async ({ screen }) => {
  const field = screen.getByTestId('text_field');
  await field.fill('to be removed');
  await field.clear();
  await expect(field).toHaveValue('');
});

test('the stepper counts and the reset button resets it', async ({ screen, platform }) => {
  // Android shows the count in its own view; iOS reports it as the stepper's value.
  const increment = screen.getByTestId(platform === 'android' ? 'stepper_increment' : 'stepper-Increment');
  const expectCount = async (n: number) => {
    if (platform === 'android') await expect(screen.getByTestId('stepper_value')).toHaveText(String(n));
    else await expect(screen.getByTestId('stepper')).toHaveValue(String(n));
  };

  await increment.tap();
  await expectCount(1);
  await increment.tap();
  await expectCount(2);

  await screen.getByTestId('button').tap();
  await expectCount(0);
});

test('a disabled button is reported as disabled', async ({ screen }) => {
  await expect(screen.getByTestId('disabled_button')).toBeDisabled();
});

test('check and uncheck set the toggle, and checking it again leaves it on', async ({ screen }) => {
  const toggle = screen.getByTestId('toggle');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  // Already checked: check() must not tap it off again.
  await toggle.check();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
});
