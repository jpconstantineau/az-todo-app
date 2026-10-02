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
  const update = document.getElementById('appUpdateStatus');
  if (!('serviceWorker' in navigator)) {
    offline.textContent = 'This browser cannot reopen the inbox offline. Keep this page open or reconnect to reopen it.';
    return;
  }
  const waiting = () => {
    update.textContent = 'An app update is ready. Wait for your draft to be saved on device, then close all app tabs and app windows and reopen. Pending saves stay on this device.';
  };
  const failed = () => {
    update.textContent = 'The app update could not finish. Your current app and saved work remain available. Reopen online to retry.';
  };
  offline.textContent = 'Preparing offline reopening… Keep this page open until ready.';
  navigator.serviceWorker.register('/inbox-sw.js', { updateViaCache: 'none' }).then(async registration => {
    function watchWorker() {
      const worker = registration.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && registration.active && registration.waiting) waiting();
        if (worker.state === 'redundant') {
          if (registration.active) failed();
          else offline.textContent = 'Offline reopening is not ready. Reopen online to retry; keep a copy of any unsynced work.';
        }
      });
    }
    registration.addEventListener('updatefound', watchWorker);
    watchWorker();
    if (registration.active && registration.waiting) waiting();
    await navigator.serviceWorker.ready;
    await new Promise((resolve, reject) => {
      const reply = new MessageChannel();
      const timeout = setTimeout(() => { reply.port1.close(); reject(new Error('Old shell is still active')); }, 2000);
      reply.port1.onmessage = event => {
        clearTimeout(timeout); reply.port1.close();
        if (event.data === 'todo-inbox-shell-v9') resolve(); else reject(new Error('Old shell is still active'));
      };
      (navigator.serviceWorker.controller || registration.active).postMessage('shell-version', [reply.port2]);
    });
    offline.textContent = 'Ready to reopen this inbox offline.';
  }).catch(() => {
    offline.textContent = 'Offline reopening is not ready. Save your work on device, close all app tabs and app windows, then reopen online to finish the update.';
  });
})();
