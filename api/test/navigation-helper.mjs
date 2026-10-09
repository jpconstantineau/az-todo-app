export async function showView(page, view) {
  await page.locator('#workspace').waitFor({ state: 'visible' });
  if (await page.locator('#dataRecovery:modal').count()) await page.locator('#closeDataRecovery').click();
  if (await page.locator('#appDevice:modal').count()) await page.locator('#closeAppDevice').click();
  while (new URL(page.url()).hash.startsWith('#preferences')) {
    const hash = new URL(page.url()).hash;
    await page.locator(hash === '#preferences' ? '#preferencesBack' : '.preferences-detail:not([hidden]) .preference-back').click();
    await page.waitForFunction(previous => location.hash !== previous, hash);
  }
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
    await page.waitForFunction(ids => ids.includes(document.activeElement?.id), {
      capture: ['captureText', 'workspaceSelect'], work: ['itemsHeading'], lists: ['itemsHeading'],
      plan: ['planHeading'], execute: ['executeHeading'], reviews: ['reviewsHeading']
    }[view]);
  }
}

// Exercise the routed Menu entry and await its applied focus contract.
export async function openMenu(page) {
  if (new URL(page.url()).hash !== '#menu') {
    await page.locator('#appMenu').click();
    await page.waitForFunction(() => location.hash === '#menu' && document.activeElement?.id === 'menuHeading');
  } else await page.locator('#menuView').waitFor();
}
export async function openPreferences(page) {
  if (new URL(page.url()).hash !== '#preferences') {
    await openMenu(page);
    await page.locator('#openPreferences').click();
    await page.waitForFunction(() => location.hash === '#preferences' && document.activeElement?.id === 'preferencesHeading');
  } else await page.locator('#preferencesView').waitFor();
}
export async function openPreference(page, id) {
  const route = `#preferences/${id}`;
  if (new URL(page.url()).hash !== route) {
    await openPreferences(page);
    await page.locator(`[data-preference-id="${id}"]`).click();
    await page.waitForFunction(expected => location.hash === expected && document.activeElement?.closest('.preferences-detail')?.hidden === false, route);
  }
}
export async function revealControl(control) {
  // Open the routed utility hub and its current native surface before controls.
  await control.waitFor({ state: 'attached' });
  const page = control.page();
  const inMenu = await control.evaluate(element => !!element.closest('#menuView'));
  if (inMenu && await page.locator('dialog:modal').count()) await page.keyboard.press('Escape');
  if (inMenu && !await control.isVisible()) await openMenu(page);
  const preference = control.locator('xpath=ancestor::section[contains(@class,"preferences-detail")][1]');
  if (await preference.count() && !await preference.isVisible()) {
    await openPreferences(page);
    const id = (await preference.getAttribute('id')).replace('preferences', '').replace(/^[A-Z]/, value => value.toLowerCase()).replace(/[A-Z]/g, value => '-' + value.toLowerCase());
    await page.locator(`[data-preference-id="${id}"]`).click();
    await preference.waitFor({ state: 'visible' });
  }
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
