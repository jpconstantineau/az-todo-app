// Runs before CSS to apply a saved choice before the first paint.
(() => {
  const key = 'todo-appearance';
  let choice = 'dark';
  function apply(value) {
    choice = value;
    document.documentElement.dataset.theme = value;
    document.querySelectorAll('[data-appearance]').forEach(select => { select.value = value; });
  }
  function restore() {
    let value;
    try { value = localStorage.getItem(key); } catch { /* Dark remains the default without storage. */ }
    apply(['light', 'dark', 'system'].includes(value) ? value : 'dark');
  }
  restore();
  document.addEventListener('DOMContentLoaded', () => apply(choice));
  document.addEventListener('htmx:afterSwap', () => apply(choice));
  document.addEventListener('change', event => {
    if (!event.target.matches('[data-appearance]')) return;
    apply(event.target.value);
    try {
      localStorage.setItem(key, choice);
    } catch { /* Keep the current tab's choice when storage is unavailable. */ }
  });
  addEventListener('storage', event => { if (event.key === key || event.key === null) restore(); });
  document.addEventListener('click', event => {
    const opener = event.target.closest('[data-open-preferences]');
    if (opener) document.getElementById('preferences').showModal();
    if (event.target.closest('[data-close-preferences]')) document.getElementById('preferences').close();
  });
})();
