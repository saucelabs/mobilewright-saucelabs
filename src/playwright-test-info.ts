import { createRequire } from 'node:module';
import { join } from 'node:path';
import createDebug from 'debug';

const debug = createDebug('mw:mobilewright-driver');

/** The parts of Playwright's TestInfo the driver uses to report a test to Sauce Labs. */
export interface CurrentTest {
  titlePath: string[];
  retry: number;
  status?: string;
  expectedStatus?: string;
  /** Shown at the top of the test in Playwright's HTML report. */
  annotations?: Array<{ type: string; description?: string }>;
}

type PlaywrightTestModule = { test: { info(): CurrentTest } };

let playwrightTest: PlaywrightTestModule | null | undefined;

/**
 * Loads the `@playwright/test` copy the user's tests run on. `test.info()` reads state held by that copy,
 * so it is resolved the way `@mobilewright/test` resolves it, falling back to the project's own.
 */
function loadPlaywrightTest(): PlaywrightTestModule | null {
  if (playwrightTest !== undefined) return playwrightTest;
  const fromProject = createRequire(join(process.cwd(), 'package.json'));
  const origins: Array<() => NodeJS.Require> = [
    () => createRequire(fromProject.resolve('@mobilewright/test')),
    () => fromProject,
  ];
  for (const origin of origins) {
    try {
      playwrightTest = origin()('@playwright/test') as PlaywrightTestModule;
      return playwrightTest;
    } catch {
      // try the next origin
    }
  }
  debug('@playwright/test not found; tests will not be reported to Sauce Labs');
  playwrightTest = null;
  return playwrightTest;
}

/** The Playwright test running in this process right now, or undefined outside a test. */
export function currentPlaywrightTest(): CurrentTest | undefined {
  try {
    return loadPlaywrightTest()?.test.info();
  } catch {
    return undefined; // test.info() throws outside a running test
  }
}
