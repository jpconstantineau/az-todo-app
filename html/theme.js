// Runs before CSS to apply a saved choice before the first paint.
(() => {
  const key = 'todo-appearance';
  let choice = 'system';
  function apply(value) {
    choice = value;
    if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value;
    else delete document.documentElement.dataset.theme;
    document.querySelectorAll('[data-appearance]').forEach(select => { select.value = value; });
  }
  function restore() {
    let value;
    try { value = localStorage.getItem(key); } catch { /* System preference works without storage. */ }
    apply(['light', 'dark'].includes(value) ? value : 'system');
  }
  restore();
  document.addEventListener('DOMContentLoaded', () => apply(choice));
  document.addEventListener('htmx:afterSwap', () => apply(choice));
  document.addEventListener('change', event => {
    if (!event.target.matches('[data-appearance]')) return;
    apply(event.target.value);
    try {
      if (choice === 'system') localStorage.removeItem(key);
      else localStorage.setItem(key, choice);
    } catch { /* Keep the current tab's choice when storage is unavailable. */ }
  });
  addEventListener('storage', event => { if (event.key === key || event.key === null) restore(); });
})();
