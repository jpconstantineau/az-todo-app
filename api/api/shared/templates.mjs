// api/shared/templates.mjs
export function esc(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function layoutShell({ title = "GTD To‑Do", user, lists = [], selectedList = null, items = [] , content = '' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div class="container">
    <header class="row">
      <h1 class="max">${title}</h1>
      <div class="nav auth" style="margin-left:auto;">
        ${user ? `
          <form id="logoutForm" method="post" action="/logout" style="display:inline;">
            <button class="button text logout" type="submit">Logout</button>
          </form>
        ` : `<a class="button text" href="/login">Login</a>`}
      </div>
    </header>

    <div class="app-grid">
      <aside class="sidebar blade">
        <div class="panel-title">
          <span>Lists</span>
          <button id="addListBtn" class="button text">Add</button>
        </div>

        <div id="listsContainer">
          ${listsBlock({ lists, selectedList })}
        </div>
      </aside>

      <main class="main">
        <header class="row">
          <h2 id="selectedListTitle">${selectedList ? escapeHtml(selectedList.title) : 'No list selected'}</h2>
        </header>

        <div style="margin:8px 0;">
          <button id="toggleAddItem" class="add-item-toggle" aria-expanded="false">＋ Add New Item</button>
        </div>

        <section id="addItemForm" class="add-item-form" aria-hidden="true">
          ${quickAddItemForm({ listId: selectedList ? selectedList.id : '' })}
        </section>

        <section id="itemsContainer" class="items-table">
          ${itemsList({ items })}
        </section>

        ${content}
      </main>
    </div>
  </div>

  <script>
  // Toggle add-item form (keeps behavior consistent for server-rendered pages)
  (function(){
    var btn = document.getElementById('toggleAddItem');
    var form = document.getElementById('addItemForm');
    if (!btn || !form) return;
    btn.addEventListener('click', function(){
      var open = form.classList.toggle('open');
      form.setAttribute('aria-hidden', String(!open));
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? '✕ Close' : '＋ Add New Item';
    });
  })();
  </script>
</body>
</html>`;
}

// Helper: render lists block (keeps simple markup used by styles.css)
export function listsBlock({ lists = [], selectedList = null } = {}) {
  return `
  ${lists.map(list => `
    <div class="list-item${selectedList && list.id === selectedList.id ? ' active' : ''}" data-id="${list.id}">
      <div class="title">${escapeHtml(list.title)}</div>
      <div class="muted nowrap">${list.count ?? ''}</div>
    </div>
  `).join('')}
  `;
}

// Helper: render items as rows
export function itemsList({ items = [] } = {}) {
  if (!items || items.length === 0) {
    return `<div class="card muted">No items</div>`;
  }

  return items.map(it => `
    <article class="item" data-id="${it.id}">
      <div class="meta">${it.due ? escapeHtml(it.due) : ''} ${it.tag ? '· ' + escapeHtml(it.tag) : ''}</div>
      <div class="title">${escapeHtml(it.title)}</div>
      <div class="actions">
        <form method="post" action="/items/${it.id}/complete" style="display:inline;">
          <button class="button text">Done</button>
        </form>
        <form method="post" action="/items/${it.id}/delete" style="display:inline;">
          <button class="button text">Delete</button>
        </form>
      </div>
    </article>
  `).join('');
}

// Quick add item form (hidden by default; toggled by JS)
export function quickAddItemForm({ listId = '' } = {}) {
  return `
  <form id="quickAdd" class="row" method="post" action="/items">
    <input type="hidden" name="listId" value="${escapeHtml(listId)}" />
    <div class="field">
      <input name="title" placeholder="Item title" required />
    </div>
    <div class="field">
      <input name="due" placeholder="Due (optional)" />
    </div>
    <div class="field">
      <input name="tag" placeholder="Tag (optional)" />
    </div>
    <div>
      <button class="button primary" type="submit">Add</button>
    </div>
  </form>
  `;
}

// small utility to avoid XSS when inserting plain strings in template helpers
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}