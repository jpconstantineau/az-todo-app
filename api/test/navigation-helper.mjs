export async function showView(page, view) {
  await page.locator('#workspace').waitFor({ state: 'visible' });
  while (/^#(?:app-device|data-recovery)/.test(new URL(page.url()).hash)) {
    const hash = new URL(page.url()).hash;
    const back = hash === '#app-device' || hash === '#data-recovery' ? '#utilityHubBack' : '#utilityMasterBack:visible, .utility-page:not([hidden]) .utility-back:visible';
    await page.locator(back).click();
    await page.waitForFunction(previous => location.hash !== previous, hash);
  }
  while (new URL(page.url()).hash.startsWith('#preferences') || /^#lists\/[A-Za-z0-9_-]+\/task-options/.test(new URL(page.url()).hash)) {
    const hash = new URL(page.url()).hash;
    const back = /^#lists\/[A-Za-z0-9_-]+\/task-options\//.test(hash) ? '#taskOptionEditorBack'
      : /^#lists\/[A-Za-z0-9_-]+\/task-options$/.test(hash) ? '#taskOptionsMasterBack'
      : hash === '#preferences' ? '#preferencesBack'
      : hash.startsWith('#preferences/task-options/') ? '#taskOptionEditorBack'
      : hash === '#preferences/task-options' ? '#taskOptionsMasterBack'
      : hash.startsWith('#preferences/process/clarify-actions/edit/') || hash === '#preferences/process/clarify-actions/add' ? '#clarifyActionEditorBack'
        : hash === '#preferences/process/clarify-actions' ? '#clarifyActionsBack' : '.preferences-detail:not([hidden]) .preference-back:visible';
    await page.locator(back).click();
    await page.waitForFunction(previous => location.hash !== previous, hash);
  }
  if (new URL(page.url()).hash === '#menu') {
    await page.waitForFunction(() => location.hash !== '#menu' || !document.querySelector('#menuView').hidden);
    if (new URL(page.url()).hash === '#menu') {
      await page.locator('#menuBack').click();
      await page.waitForFunction(() => location.hash !== '#menu');
      return showView(page, view);
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
    if (new URL(page.url()).hash.startsWith('#preferences/') || /^#lists\/[A-Za-z0-9_-]+\/task-options/.test(new URL(page.url()).hash)) await showView(page, 'capture');
    await openMenu(page);
    await page.locator('#openPreferences').click();
    await page.waitForFunction(() => location.hash === '#preferences' && document.activeElement?.id === 'preferencesHeading');
  } else await page.locator('#preferencesView').waitFor();
}
export async function openUtility(page, route) {
  const group = route.split('/')[0], expected = '#' + route;
  if (new URL(page.url()).hash === expected) return;
  await showView(page, 'capture');
  await openMenu(page);
  await page.locator(group === 'app-device' ? '#openAppDevice' : '#openDataRecovery').click();
  await page.waitForFunction(expectedGroup => location.hash === expectedGroup, '#' + group);
  if (route !== group) {
    await page.locator(`#utilityRows a[href="${expected}"]`).click();
    await page.waitForFunction(expectedRoute => location.hash === expectedRoute, expected);
  }
}
export async function openPreference(page, id) {
  const route = `#preferences/${id}`;
  if (new URL(page.url()).hash !== route) {
    await openPreferences(page);
    await page.locator(`[data-preference-id="${id}"]`).click();
    await page.waitForFunction(({ expected, taskOptions }) => location.hash === expected && (taskOptions
      ? !document.querySelector('#taskOptionsView').hidden && document.activeElement?.id === 'taskOptionsMasterHeading'
      : document.activeElement?.closest('.preferences-detail')?.hidden === false), { expected: route, taskOptions: id === 'task-options' });
  }
}
export async function openAccountTaskOption(page, field = 'contexts') {
  const route = `#preferences/task-options/${field}`;
  if (new URL(page.url()).hash !== route) {
    await openPreference(page, 'task-options');
    await page.locator(`#task-option-${field}`).click();
    await page.waitForFunction(expected => location.hash === expected && document.activeElement?.id === 'taskOptionHeading', route);
  }
}
export async function openListTaskOption(page, listLabel, field = 'contexts') {
  await showView(page, 'lists');
  await page.locator('#view').selectOption({ label: listLabel });
  await page.getByRole('button', { name: `Task options: ${listLabel}`, exact: true }).click();
  await page.waitForFunction(() => /^#lists\/[A-Za-z0-9_-]+\/task-options$/.test(location.hash) && document.activeElement?.id === 'taskOptionsMasterHeading');
  await page.locator(`#task-option-${field}`).click();
  await page.waitForFunction(expected => location.hash.endsWith(`/task-options/${expected}`) && document.activeElement?.id === 'taskOptionHeading', field);
}
export async function openClarificationPreferences(page) {
  if (new URL(page.url()).hash !== '#preferences/process/clarify-actions') {
    await openPreference(page, 'process');
    await page.locator('#openClarifyActions').click();
    await page.waitForFunction(() => location.hash === '#preferences/process/clarify-actions' && document.activeElement?.id === 'clarifyActionsHeading');
  }
}
export async function revealControl(control) {
  // Open the routed utility hub and its current native surface before controls.
  await control.waitFor({ state: 'attached' });
  const page = control.page();
  const inMenu = await control.evaluate(element => !!element.closest('#menuView'));
  if (inMenu && await page.locator('dialog:modal').count()) await page.keyboard.press('Escape');
  if (inMenu && !await control.isVisible()) await openMenu(page);
  const utilityRoutes = {
    appDeviceInstall: 'app-device/install', appDeviceOffline: 'app-device/offline', appDeviceUpdates: 'app-device/updates', appDeviceConnection: 'app-device/connection',
    dataRecoveryExport: 'data-recovery/export', deletedRecords: 'data-recovery/deleted', dataRecoveryUndo: 'data-recovery/undo', dataRecoveryRestore: 'data-recovery/restore-from-cloud'
  };
  const utilityPage = control.locator('xpath=ancestor::section[contains(concat(" ", normalize-space(@class), " "), " utility-page ")][1]');
  if (await utilityPage.count() && !await utilityPage.isVisible()) await openUtility(page, utilityRoutes[await utilityPage.getAttribute('id')]);
  if (await control.getAttribute('id') === 'openDeleted' && !await control.isVisible()) await openUtility(page, 'data-recovery');
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
    await page.waitForFunction(() => document.querySelector('#workspace').hidden
      || (location.hash !== '#menu' && document.querySelector('#menuView').hidden));
  }
}
