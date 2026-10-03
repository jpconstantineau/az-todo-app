import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { documents, startServer } from './harness.mjs';

const local = page => page.evaluate(async () => (await (await import('/inbox-store.js')).transact('alice')).sharedLists);
const settled = page => page.waitForFunction(async () => {
  const session = await (await import('/inbox-store.js')).transact(null);
  const data = await (await import('/inbox-store.js')).transact(session.accountId);
  return !data.sharedLists?.pending && !document.querySelector('#sharedContent').hidden;
});
const openDetails = async locator => locator.evaluate(element => { element.open = true; });

test('shared lists browser: create, invite, constrained member, offline conflict/revocation and account isolation', { timeout: 90000 }, async t => {
  documents.length = 0;
  // Two servers provide independently authenticated browser sessions over one store.
  let alice = 'alice';
  const a = await startServer({ browserUser: () => alice }), b = await startServer({ browserUser: 'bob' });
  t.after(a.close); t.after(b.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const owner = await browser.newContext({ viewport: { width: 390, height: 844 } }), member = await browser.newContext();
  const page = await owner.newPage(), second = await member.newPage(), errors = [];
  for (const p of [page, second]) { p.on('pageerror', e => errors.push(e.message)); p.on('dialog', dialog => dialog.accept()); }
  // Install the real app shell to verify that shared list assets reopen offline.
  await page.goto(a.url); await page.locator('#workspace').waitFor();
  await page.waitForFunction(() => document.querySelector('#offlineStatus').textContent.includes('Ready to reopen'));
  await page.goto(a.url + '/shared.html'); await page.locator('#sharedMain').waitFor();
  await openDetails(page.locator('details').filter({ has: page.locator('#createShared') }));
  await page.locator('#createShared input').fill('Family groceries');
  await page.locator('#createShared button').click(); await settled(page);
  const id = (await local(page)).selected;
  await page.locator('#addShared input').fill('Milk'); await page.locator('#addShared button').click(); await settled(page);
  await page.getByRole('button', { name: 'Complete Milk', exact: true }).waitFor();
  await openDetails(page.locator('#sharedOwner'));
  await page.locator('#inviteShared button').click(); await settled(page);
  await page.locator('#invitationResult').waitFor();
  const invite = await page.locator('#invitationLink').inputValue();
  assert.ok(invite.includes('#listId='));
  await second.goto(invite.replace(a.url, b.url)); await second.locator('#sharedMain').waitFor();
  assert.equal(new URL(second.url()).hash, '', 'invitation removed from visible history');
  await second.locator('#joinShared button').click(); await settled(second);
  await second.getByRole('button', { name: 'Complete Milk', exact: true }).waitFor();
  assert.equal(await second.getByRole('button', { name: 'Edit Milk', exact: true }).isDisabled(), true);
  assert.equal(await second.getByRole('button', { name: 'Delete Milk', exact: true }).isDisabled(), true);
  assert.equal(await second.locator('#sharedOwner').isVisible(), false);
  await second.getByRole('button', { name: 'Complete Milk', exact: true }).click(); await settled(second);
  await second.getByRole('button', { name: 'Reopen Milk', exact: true }).waitFor();
  await page.locator('#sharedRefresh').click();
  await page.getByRole('button', { name: 'Reopen Milk', exact: true }).waitFor();
  await owner.setOffline(true);
  await page.locator('#addShared input').fill('Saved offline'); await page.locator('#addShared button').click();
  await page.locator('#sharedPending').waitFor();
  await page.reload(); await page.locator('#sharedMain').waitFor(); await page.locator('#sharedPending').waitFor();
  assert.equal((await local(page)).pending.operation.fields.title, 'Saved offline');
  await second.locator('#addShared input').fill('Bread'); await second.locator('#addShared button').click(); await settled(second);
  await owner.setOffline(false); await page.locator('#sharedRefresh').click();
  await page.locator('#reviewShared').waitFor();
  assert.equal((await local(page)).pending.code, 'shared_conflict');
  await page.locator('#reviewShared').click(); await settled(page);
  await page.getByRole('button', { name: 'Complete Saved offline', exact: true }).waitFor();
  await second.locator('#sharedRefresh').click(); await second.getByRole('button', { name: 'Complete Saved offline', exact: true }).waitFor();
  await member.setOffline(true);
  await second.locator('#addShared input').fill('Do not lose revoked work'); await second.locator('#addShared button').click(); await second.locator('#sharedPending').waitFor();
  await openDetails(page.locator('#sharedOwner'));
  await page.getByRole('button', { name: 'Remove Member', exact: true }).click(); await settled(page);
  await member.setOffline(false); await second.locator('#sharedRefresh').click();
  await second.waitForFunction(() => document.querySelector('#pendingText').textContent.includes('permission was removed'));
  assert.equal(await second.locator('#sharedContent').isVisible(), false);
  assert.match(await second.locator('#pendingText').textContent(), /Do not lose revoked work/);
  assert.equal(documents.find(d => d.kind === 'shared-list').items.length, 3);
  await page.locator('#addShared input').fill('Alice private draft');
  await page.waitForFunction(async id => (await (await import('/inbox-store.js')).transact('alice')).sharedLists.drafts[id]?.add === 'Alice private draft', id);
  alice = 'eve'; await page.locator('#sharedRefresh').click(); await page.locator('#sharedSignIn').waitFor();
  assert.equal(await page.locator('#sharedMain').isVisible(), false);
  assert.equal(await page.locator('#addShared input').inputValue(), '');
  alice = 'alice'; await page.reload(); await page.locator('#sharedMain').waitFor();
  assert.equal(await page.locator('#addShared input').inputValue(), 'Alice private draft');
  assert.deepEqual(errors, []);
});

test('shared lists browser: edit/delete recovery, permissions, export, responsive layouts and keyboard focus', { timeout: 60000 }, async t => {
  documents.length = 0;
  const server = await startServer({ browserUser: 'alice' }); t.after(server.close);
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('dialog', dialog => dialog.accept());
  await page.goto(server.url + '/shared.html'); await page.locator('#sharedMain').waitFor();
  await openDetails(page.locator('details').filter({ has: page.locator('#createShared') }));
  await page.locator('#createShared input').fill('Weekend shopping'); await page.locator('#createShared button').click(); await settled(page);
  await page.locator('#addShared input').fill('<img src=x> Milk'); await page.locator('#addShared button').click(); await settled(page);
  await page.getByRole('button', { name: 'Edit <img src=x> Milk', exact: true }).click();
  await page.locator('#editShared input').fill('Oat milk'); await page.locator('#editShared button[type=submit]').click(); await settled(page);
  await page.locator('#sharedEditor').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Delete Oat milk', exact: true }).click(); await settled(page);
  await openDetails(page.locator('details').filter({ has: page.locator('#sharedDeleted') }));
  await page.getByRole('button', { name: 'Restore Oat milk', exact: true }).click(); await settled(page);
  await page.getByRole('button', { name: 'Edit Oat milk', exact: true }).waitFor();
  assert.equal(await page.locator('#sharedItems img').count(), 0);
  await openDetails(page.locator('#sharedOwner'));
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (process.env.SHARED_SCREENSHOTS) {
        await mkdir(process.env.SHARED_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: `${process.env.SHARED_SCREENSHOTS}/shared-${theme}-${width}.png`, fullPage: true });
      }
    }
  }
  const download = page.waitForEvent('download'); await page.locator('#sharedExport').click();
  assert.equal((await download).suggestedFilename(), 'shared-lists-device-copy.json');
  await page.locator('#deleteShared').click(); await settled(page);
  await page.locator('#restoreShared').waitFor(); await page.locator('#restoreShared').click(); await settled(page);
  await page.getByRole('button', { name: 'Edit Oat milk', exact: true }).waitFor();
  assert.equal(documents.find(d => d.kind === 'shared-list').items.length, 1);
});
