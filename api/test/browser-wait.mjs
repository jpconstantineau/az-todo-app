import { setTimeout } from 'node:timers/promises';

// Playwright's waitForFunction treats a Promise as truthy instead of polling its value.
export async function waitForBrowser(page, predicate, arg, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!await page.evaluate(predicate, arg)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for browser state: ' + predicate);
    await setTimeout(25);
  }
}
