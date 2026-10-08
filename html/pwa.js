// Installation and shell readiness are independent of authentication and task storage.
(() => {
  const button = document.getElementById('installApp');
  const status = document.getElementById('installStatus');
  const help = document.getElementById('installHelp');
  const standalone = matchMedia('(display-mode: standalone)');
  let promptEvent, installed = standalone.matches || navigator.standalone === true;
  let dismissed = false;
  try { dismissed = localStorage.getItem('todo-install-dismissed') === 'true'; } catch { /* Optional preference. */ }
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  document.getElementById('installInstructions').textContent = ios
    ? 'On iPhone or iPad, open this site in Safari, choose Share, then Add to Home Screen. Enable Open as Web App if offered, then tap Add.'
    : /Android/.test(navigator.userAgent)
      ? 'In Chrome on Android, open the browser menu and choose Install app or Add to Home screen, if offered.'
      : 'In Chrome or Edge, use the address bar install icon or the browser menu to install this site as an app, if offered. On Mac Safari, choose File, then Add to Dock. You can also keep using it in this browser.';

  function render() {
    button.hidden = installed || dismissed || !promptEvent;
    help.hidden = installed;
    if (installed) status.textContent = 'To-Do is installed on this device.';
  }
  addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    promptEvent = event;
    render();
  });
  addEventListener('appinstalled', () => { installed = true; promptEvent = null; render(); });
  standalone.addEventListener('change', event => {
    installed = event.matches || navigator.standalone === true;
    render();
  });
  button.addEventListener('click', async () => {
    const offered = promptEvent;
    if (!offered || installed) return;
    promptEvent = null;
    button.disabled = true;
    try {
      await offered.prompt();
      const { outcome } = await offered.userChoice;
      if (outcome === 'accepted') {
        installed = true;
      } else {
        dismissed = true;
        try { localStorage.setItem('todo-install-dismissed', 'true'); } catch { /* Still suppress repeats in this page. */ }
        status.textContent = 'Installation dismissed. You can install later from your browser menu.';
      }
    } catch {
      status.textContent = 'Installation could not open. Use Installation help or your browser menu.';
    } finally {
      button.disabled = false;
      render();
      if (document.getElementById('preferences').open) {
        document.querySelector(installed ? '[data-close-preferences]' : '#installHelp summary').focus();
      }
    }
  });
  render();

  const offline = document.getElementById('offlineStatus');
  function offlineStatus(text, ready = false) {
    offline.textContent = text;
    document.getElementById('offlineBadge').textContent = ready ? '' : ' · ⚠ Offline setup';
  }
  const update = document.getElementById('appUpdateStatus');
  const check = document.getElementById('checkAppUpdate');
  const checkStatus = document.getElementById('checkAppUpdateStatus');
  function updateStatus(text) {
    update.textContent = text;
    checkStatus.textContent = text;
  }
  if (!('serviceWorker' in navigator)) {
    offlineStatus('This browser cannot reopen the inbox offline. Keep this page open or reconnect to reopen it.');
    check.hidden = true;
    checkStatus.textContent = 'App update checks are unavailable in this browser. Reopen online to load the latest app.';
    return;
  }
  const waiting = () => {
    updateStatus('An app update is ready. Wait for your draft to be saved on device, then close all app tabs and app windows and reopen. Pending saves stay on this device.');
    update.textContent = 'An app update is ready. Open Menu → Preferences for details.';
  };
  const failed = () => {
    updateStatus('The app update could not finish. Your saved work stays on this device. Use Check for updates in Preferences to retry online.');
  };
  const notReady = () => offlineStatus('Offline reopening is not ready. Retry online with Check for updates in Preferences. If an update is ready, save your work on device, close all app tabs and app windows, then reopen.');
  let registration;
  offlineStatus('Preparing offline reopening… Keep this page open until ready.');
  async function register() {
    registration = await navigator.serviceWorker.register('/inbox-sw.js', { updateViaCache: 'none' });
    function watchWorker() {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && registration.active && registration.waiting) waiting();
        if (worker.state === 'redundant') {
          if (registration.active) failed();
          else offlineStatus('Offline reopening is not ready. Retry online with Check for updates in Preferences; keep a copy of any unsynced work.');
        }
      });
    }
    registration.addEventListener('updatefound', watchWorker);
    watchWorker();
    if (registration.active && registration.waiting) waiting();
    void verifyOfflineReady().catch(notReady);
    return registration;
  }
  async function verifyOfflineReady() {
    await navigator.serviceWorker.ready;
    await new Promise((resolve, reject) => {
      const reply = new MessageChannel();
      const timeout = setTimeout(() => { reply.port1.close(); reject(new Error('Old shell is still active')); }, 2000);
      reply.port1.onmessage = event => {
        clearTimeout(timeout); reply.port1.close();
        if (event.data === 'todo-inbox-shell-v27') resolve(); else reject(new Error('Old shell is still active'));
      };
      (navigator.serviceWorker.controller || registration.active).postMessage('shell-version', [reply.port2]);
    });
    offlineStatus('Ready to reopen this inbox offline.', true);
  }
  check.addEventListener('click', async () => {
    if (check.disabled || check.getAttribute('aria-disabled') === 'true') return;
    if (registration?.waiting) { waiting(); return; }
    if (!navigator.onLine) {
      checkStatus.textContent = 'You are offline. Reconnect, then choose Check for updates. Your saved work stays on this device.';
      return;
    }
    // Keep keyboard focus while a check runs; repeated activation is ignored above.
    check.setAttribute('aria-disabled', 'true');
    checkStatus.textContent = 'Checking for app updates…';
    let timeout, worker, changed, finished = false;
    try {
      await Promise.race([
        (async () => {
          const current = registration?.active || registration?.installing || registration?.waiting ? registration : await register();
          if (finished) return;
          await current.update();
          if (finished) return;
          worker = current.installing;
          if (worker) {
            checkStatus.textContent = 'Downloading app update… You can keep working.';
            await new Promise((resolve, reject) => {
              changed = () => {
                if (['installed', 'activating', 'activated'].includes(worker.state)) resolve();
                else if (worker.state === 'redundant') reject(new Error('Update failed'));
              };
              worker.addEventListener('statechange', changed);
              changed();
            });
          }
        })(),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Update timed out')), 30000); })
      ]);
      if (registration.waiting) waiting();
      else {
        update.textContent = '';
        checkStatus.textContent = registration.active ? 'To-Do is up to date.' : 'Offline setup is finishing. Keep this page open until ready.';
      }
    } catch {
      if (registration?.waiting) waiting();
      else failed();
    } finally {
      finished = true;
      clearTimeout(timeout);
      if (worker && changed) worker.removeEventListener('statechange', changed);
      check.removeAttribute('aria-disabled');
    }
  });
  void register().catch(notReady).finally(() => { check.disabled = false; });
})();
