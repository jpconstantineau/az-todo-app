export async function showView(page, view) {
  await page.locator('#workspace').waitFor({ state: 'visible' });
  if (await page.locator('#dataRecovery:modal').count()) await page.locator('#closeDataRecovery').click();
  if (new URL(page.url()).hash === '#menu') {
    await page.waitForFunction(() => location.hash !== '#menu' || !document.querySelector('#menuView').hidden);
    if (new URL(page.url()).hash === '#menu') {
      await page.locator('#menuBack').click();
      await page.waitForFunction(() => location.hash !== '#menu');
    }
  }
  const link = page.locator('.workspace-nav a[href="#' + view + '"]');
  await link.waitFor({ state: 'visible' });
  if (await link.getAttribute('aria-current') !== 'page') {
    await link.click();
    await page.waitForFunction(hash => document.querySelector('.workspace-nav [aria-current="page"]').hash === hash, '#' + view);
  }
}

// Exercise the routed Menu entry and await its applied focus contract.
export async function openMenu(page) {
  if (new URL(page.url()).hash !== '#menu') {
    await page.locator('#appMenu').click();
    await page.waitForFunction(() => location.hash === '#menu' && document.activeElement?.id === 'menuHeading');
  } else await page.locator('#menuView').waitFor();
}
export async function revealControl(control) {
  // Open the routed utility hub and its current native surface before controls.
  await control.waitFor({ state: 'attached' });
  const page = control.page();
  const inMenu = await control.evaluate(element => !!element.closest('#menuView'));
  if (inMenu && await page.locator('dialog:modal').count()) await page.keyboard.press('Escape');
  if (inMenu && !await control.isVisible()) await openMenu(page);
  const dialog = control.locator('xpath=ancestor::dialog[1]');
  if (await dialog.count() && !await dialog.evaluate(element => element.open)) {
    const id = await dialog.getAttribute('id');
    if (new URL(page.url()).hash !== '#menu') await openMenu(page);
    await page.locator(`[aria-controls="${id}"]`).click();
    await dialog.waitFor();
  }
  const summaries = await control.locator('xpath=ancestor::details/summary').all();
  for (const summary of summaries) {
    if (!await summary.evaluate(el => el.parentElement.open)) await summary.click();
  }
}
export async function clickControl(control) {
  const page = control.page();
  await revealControl(control);
  const id = await control.getAttribute('id');
  await control.click();
  if (id === 'sync' && new URL(page.url()).hash === '#menu' && await page.locator('#workspace').isVisible()) {
    await page.locator('#menuBack').evaluate(button => button.click());
    await page.waitForFunction(() => location.hash !== '#menu');
  }
}
