// Test-only counterpart, not the TaskGem capture UI or a production origin policy.
globalThis.openHandoff = async (operation, origin) => {
  const ticket = crypto.randomUUID().replaceAll('-', '');
  const url = origin + '/handoff.html#extension=' + chrome.runtime.id + '&ticket=' + ticket;
  const tab = await chrome.tabs.create({ url });
  await chrome.storage.local.set({ pending: { operation, origin, ticket, tabId: tab.id } });
  return url;
};
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  void (async () => {
    const { pending } = await chrome.storage.local.get('pending');
    if (!pending) { sendResponse({ error: 'no_capture' }); return; }
    const url = new URL(sender.url);
    const { operation, origin, ticket, tabId } = pending;
    if (sender.id || sender.origin !== origin || url.origin !== origin || url.pathname !== '/handoff.html' || url.search ||
        sender.frameId !== 0 || sender.tab?.id !== tabId || message.protocol !== 'taskgem-handoff-v1' ||
        message.ticket !== ticket || message.accountId !== operation.accountId ||
        typeof message.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(message.requestId)) {
      sendResponse({ error: 'untrusted_sender' }); return;
    }
    const reply = { protocol: message.protocol, type: message.type, ticket, requestId: message.requestId, accountId: operation.accountId };
    if (message.type === 'preview') { sendResponse({ ...reply, operation }); return; }
    const receipt = message.receipt;
    if (message.type !== 'acknowledge' || receipt?.apiVersion !== 1 || receipt.accountId !== operation.accountId ||
        receipt.operationId !== operation.operationId || receipt.status !== 'committed' || receipt.itemId !== operation.mutations[0].id ||
        receipt.version !== 1 || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1) {
      sendResponse({ error: 'invalid_receipt' }); return;
    }
    await chrome.storage.local.remove('pending');
    sendResponse({ ...reply, acknowledged: true });
  })().catch(() => sendResponse({ error: 'handoff_failed' }));
  return true;
});
