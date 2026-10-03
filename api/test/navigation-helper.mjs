export async function showView(page, view) {
  const link = page.locator('.workspace-nav a[href="#' + view + '"]');
  if (await link.getAttribute('aria-current') !== 'page') {
    await link.click();
    await page.waitForFunction(hash => document.querySelector('.workspace-nav [aria-current="page"]').hash === hash, '#' + view);
  }
}

// Exercise the same native disclosures as a phone user before utility/actions.
export async function openMenu(page) {
  const menu = page.locator('#appMenu');
  if (!await menu.evaluate(element => element.open)) await menu.locator(':scope > summary').click();
}
export async function clickControl(control) {
  // Open outer disclosures before inner ones, using real clicks rather than
  // bypassing visibility/actionability checks on the requested control.
  await control.waitFor({ state: 'attached' });
  const summaries = await control.locator('xpath=ancestor::details/summary').all();
  for (const summary of summaries) {
    if (!await summary.evaluate(el => el.parentElement.open)) await summary.click();
  }
  await control.click();
}
