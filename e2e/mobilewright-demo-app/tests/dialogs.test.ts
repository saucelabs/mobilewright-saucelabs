import { expect, test } from '@mobilewright/test';
import type { Dialog, Screen } from 'mobilewright';

const PLAYGROUND = 'com.mobilenext.playground';

// clearAppData() resets the app's permissions, so permission prompts show up on every run: Android clears
// the app's data, iOS reinstalls it.
test.beforeEach(async ({ device, screen }) => {
  await device.clearAppData(PLAYGROUND);
  await device.launchApp(PLAYGROUND);
  await screen.getByText('Permissions and Alerts').tap();
});

/** Answers every dialog with `respond`, and returns the dialogs seen. */
function answerDialogs(screen: Screen, respond: (dialog: Dialog) => Promise<void>): Dialog[] {
  const seen: Dialog[] = [];
  screen.on('dialog', async (dialog) => {
    seen.push(dialog);
    await respond(dialog);
  });
  return seen;
}

async function press(screen: Screen, testId: string): Promise<void> {
  // The alert buttons sit below the fold on smaller screens. Scrolling the action sheet button (below them on
  // both platforms) into view first brings them fully on screen: a button cut off at the bottom edge counts as
  // in view (Android reports the visible part of its bounds), and a tap on that sliver lands in the system
  // gesture area.
  if (testId.startsWith('show_')) await screen.getByTestId('show_action_sheet_button').scrollIntoViewIfNeeded();
  const button = screen.getByTestId(testId);
  await button.scrollIntoViewIfNeeded();
  await button.tap();
}

test('dismissing a confirm alert presses Cancel', async ({ screen }) => {
  const dialogs = answerDialogs(screen, (dialog) => dialog.dismiss());
  await press(screen, 'show_confirm_alert_button');
  await expect(screen.getByTestId('alert_result')).toHaveText('Cancel');
  expect(dialogs.map((d) => [d.type(), d.title(), d.message()])).toEqual([['confirm', 'Confirm Alert', 'Do you want to continue?']]);
  await screen.screenshot();
});

test('accepting a prompt types the answer and presses OK', async ({ screen }) => {
  answerDialogs(screen, (dialog) => dialog.accept('Sauce Labs'));
  await press(screen, 'show_prompt_alert_button');
  await expect(screen.getByTestId('alert_result')).toHaveText('Hello, Sauce Labs');
});

test('a button can be pressed by its caption', async ({ screen }) => {
  answerDialogs(screen, (dialog) => dialog.tap('Later'));
  await press(screen, 'show_three_button_alert_button');
  await expect(screen.getByTestId('alert_result')).toHaveText('Later');
});

test('accepting the location prompt grants location', async ({ screen }) => {
  const dialogs = answerDialogs(screen, (dialog) => dialog.accept());
  await press(screen, 'request_location_permission_button');
  await expect(screen.getByTestId('location_permission_status')).toHaveText('Granted');
  expect(dialogs[0].type()).toBe('permission');
  await screen.screenshot();
});

test('dismissing the camera prompt denies the camera', async ({ screen, platform }) => {
  const dialogPromise = screen.waitForEvent('dialog');
  await press(screen, 'request_camera_permission_button');
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe('permission');
  await dialog.dismiss();
  await expect(screen.getByTestId('camera_permission_status')).toHaveText(platform === 'ios' ? 'Denied' : 'Not Granted');
});
