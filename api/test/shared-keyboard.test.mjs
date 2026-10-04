import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';

const settled = page => page.waitForFunction(() => document.querySelector('#sharedMain').getAttribute('aria-busy') === 'false' && !document.querySelector('#sharedContent').hidden);
const assertFocused = async locator => {
  // Native dialog close events run after the dialog itself becomes hidden.
  await locator.page().waitForFunction(element => element === document.activeElement, await locator.elementHandle(), { timeout: 5000 });
};
async function setup(t) {
  documents.length = 0;
  let account = 'alice';
  const server = await startServer({ browserUser: () => account }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage({ serviceWorkers: 'block' });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(server.url + '/shared.html');
  await page.locator('#sharedMain').waitFor();
  await page.locator('#createShared').evaluate(form => { form.closest('details').open = true; });
  await page.locator('#createShared input').fill('Keyboard shopping');
  await page.locator('#createShared button').click(); await settled(page);
  for (let i = 0; i < 2; i++) {
    await page.locator('#addShared input').fill('Milk');
    await page.locator('#addShared button').click(); await settled(page);
  }
  return { page, switchAccount: value => { account = value; } };
}

test('shared keyboard: complete/reopen keeps the same item and editor returns to its renamed opener', async t => {
  const { page } = await setup(t);
  const second = page.locator('#sharedItems article').nth(1);
  const complete = second.getByRole('button', { name: 'Complete Milk', exact: true });
  await complete.focus(); await page.keyboard.press('Enter'); await settled(page);
  await assertFocused(second.getByRole('button', { name: 'Reopen Milk', exact: true }));
  await page.keyboard.press('Enter'); await settled(page);
  await assertFocused(complete);
  const edit = second.getByRole('button', { name: 'Edit Milk', exact: true });
  await edit.focus(); await page.keyboard.press('Enter');
  await page.locator('#editShared input').fill('Oat milk');
  await page.locator('#editShared input').press('Enter'); await settled(page);
  await page.locator('#sharedEditor').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.textContent === 'Edit Oat milk');
  await assertFocused(second.getByRole('button', { name: 'Edit Oat milk', exact: true }));
  await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  await page.locator('#sharedEditor').waitFor({ state: 'hidden' });
  await assertFocused(second.getByRole('button', { name: 'Edit Oat milk', exact: true }));
});

test('shared keyboard: refresh preserves item identity but delayed work does not steal later focus', async t => {
  const { page } = await setup(t);
  const edit = page.locator('#sharedItems article').nth(1).getByRole('button', { name: 'Edit Milk', exact: true });
  await edit.focus();
  await page.evaluate(() => document.querySelector('#sharedRefresh').click()); await settled(page);
  await assertFocused(edit);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const requested = new Promise(resolve => { started = resolve; });
  await page.route('**/api/shared/list?*', async route => { started(); await gate; await route.continue(); });
  await page.evaluate(() => document.querySelector('#sharedRefresh').click()); await requested;
  await page.locator('#addShared input').focus(); release(); await settled(page);
  await assertFocused(page.locator('#addShared input'));
});

test('shared keyboard: deletion uses a visible fallback and account changes never restore old item focus', async t => {
  const { page, switchAccount } = await setup(t);
  const deletionDialogs = [];
  page.on('dialog', dialog => { deletionDialogs.push(dialog.message()); });
  const remove = page.locator('#sharedItems article').nth(1).getByRole('button', { name: 'Delete Milk', exact: true });
  await remove.focus(); await page.keyboard.press('Enter'); await settled(page);
  assert.deepEqual(deletionDialogs, [], 'shared item deletion needs no confirmation');
  await assertFocused(page.locator('#sharedTitle'));
  await page.locator('#sharedDeleted').evaluate(element => { element.closest('details').open = true; });
  await page.getByRole('button', { name: 'Restore Milk', exact: true }).focus();
  await page.keyboard.press('Enter'); await settled(page);
  await assertFocused(page.locator('#sharedTitle'));
  await page.locator('#sharedItems article').nth(1).getByRole('button', { name: 'Edit Milk', exact: true }).click();
  switchAccount('bob');
  await page.evaluate(() => document.querySelector('#sharedRefresh').click());
  await page.locator('#sharedSignIn').waitFor();
  assert.equal(await page.locator('#sharedMain').isVisible(), false);
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('#sharedMain')), false);
});

test('shared keyboard: dialog survives refresh and closing it follows remote rename or deletion', async t => {
  const { page } = await setup(t);
  const second = page.locator('#sharedItems article').nth(1);
  await second.getByRole('button', { name: 'Edit Milk', exact: true }).click();
  await page.locator('#editShared input').fill('My unsaved correction');
  const list = documents.find(document => document.kind === 'shared-list');
  list.items[1].title = 'Remote rename'; list.revision++;
  await page.evaluate(() => document.querySelector('#sharedRefresh').click()); await settled(page);
  await assertFocused(page.locator('#editShared input'));
  assert.equal(await page.locator('#editShared input').inputValue(), 'My unsaved correction');
  await page.keyboard.press('Escape'); await page.locator('#sharedEditor').waitFor({ state: 'hidden' });
  await assertFocused(second.getByRole('button', { name: 'Edit Remote rename', exact: true }));
  await page.keyboard.press('Enter');
  list.items[1].deleted = true; list.revision++;
  await page.evaluate(() => document.querySelector('#sharedRefresh').click()); await settled(page);
  await page.keyboard.press('Escape'); await page.locator('#sharedEditor').waitFor({ state: 'hidden' });
  await assertFocused(page.locator('#sharedTitle'));
});

test('shared keyboard: offline pending completion keeps a usable fallback and returns after acknowledgement', async t => {
  const { page } = await setup(t);
  await page.context().setOffline(true);
  const second = page.locator('#sharedItems article').nth(1);
  await second.getByRole('button', { name: 'Complete Milk', exact: true }).focus();
  await page.keyboard.press('Enter'); await settled(page);
  await page.locator('#sharedPending').waitFor();
  await assertFocused(page.locator('#sharedTitle'));
  await page.context().setOffline(false);
  await page.waitForFunction(() => document.querySelector('#sharedPending').hidden && document.querySelector('#sharedMain').getAttribute('aria-busy') === 'false');
  await assertFocused(second.getByRole('button', { name: 'Reopen Milk', exact: true }));
});
