export async function showView(page, view) {
  const link = page.locator('.workspace-nav a[href="#' + view + '"]');
  if (await link.getAttribute('aria-current') !== 'page') {
    await link.click();
    await page.waitForFunction(hash => document.querySelector('.workspace-nav [aria-current="page"]').hash === hash, '#' + view);
  }
}
