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
  <script src="https://cdn.jsdelivr.net/npm/htmx.org@1.9.12"></script>
</head>
<body>
  <div class="container">
    <header class="app-header">
      <div class="header-left">
        <h1 class="app-title">${title}</h1>
      </div>
      <nav class="header-nav">
        ${user ? `
          <span class="nav-user">Signed in</span>
          <form id="logoutForm" method="post" action="/logout" style="display:inline;">
            <button class="button text logout" type="submit">Logout</button>
          </form>
        ` : `<a class="button text" href="/login">Login</a>`}
      </nav>
    </header>

    <div class="app-grid">
      <aside class="sidebar blade">
        <div class="panel-title">
          <span>Lists</span>
          <button id="showAddListBtn" class="button text">Add</button>
        </div>

        <!-- HTMX will load the lists fragment here -->
        <div id="listsContainer"
             hx-get="/api/lists"
             hx-trigger="load"
             hx-swap="innerHTML">
        </div>

        <!-- Add list form (hidden, toggled client-side) -->
        <div id="addListPanel" style="display:none; margin-top:8px;">
          <form id="addListForm" hx-post="/api/lists" hx-target="#listsContainer" hx-swap="innerHTML">
            <div class="row">
              <input name="title" placeholder="New list title" required />
              <button class="button primary" type="submit">Create</button>
            </div>
          </form>
        </div>
      </aside>

      <main class="main">
        <header class="row">
          <h2 id="selectedListTitle" data-selected-id="${selectedList ? escapeHtml(selectedList.id) : ''}">
            ${selectedList ? escapeHtml(selectedList.title) : 'No list selected'}
          </h2>
        </header>

        <div style="margin:8px 0;">
          <button id="toggleAddItem" class="add-item-toggle" aria-expanded="false">＋ Add New Item</button>
        </div>

        <!-- Quick add item form uses HTMX to post and replace the items region -->
        <section id="addItemForm" class="add-item-form" aria-hidden="true">
          ${quickAddItemForm({ listId: selectedList ? selectedList.id : '' })}
        </section>

        <!-- Items container: HTMX can load items for the selected list. If a server-selected list exists, trigger load. -->
        <section id="itemsContainer" class="items-table"
            ${selectedList ? `hx-get="/api/lists/${encodeURIComponent(selectedList.id)}/items" hx-trigger="load" hx-swap="innerHTML"` : ''}>
          ${/* When server returns initial items directly it's fine; otherwise HTMX will replace this */ ''}
          ${items && items.length ? itemsList({ items }) : ''}
        </section>

        ${content}
      </main>
    </div>
  </div>

  <script>
  // Toggle add-item form and add-list form visibility
  (function(){
    var btn = document.getElementById('toggleAddItem');
    var form = document.getElementById('addItemForm');
    var showAddListBtn = document.getElementById('showAddListBtn');
    var addListPanel = document.getElementById('addListPanel');

    if (btn && form) {
      btn.addEventListener('click', function(){
        var open = form.classList.toggle('open');
        form.setAttribute('aria-hidden', String(!open));
        btn.setAttribute('aria-expanded', String(open));
        btn.textContent = open ? '✕ Close' : '＋ Add New Item';
      });
    }

    if (showAddListBtn && addListPanel) {
      showAddListBtn.addEventListener('click', function(){
        addListPanel.style.display = addListPanel.style.display === 'none' ? 'block' : 'none';
      });
    }
  })();
  </script>
</body>
</html>`;
}

// Helper: render lists block (keeps simple markup used by styles.css)
// Each list item uses HTMX to request its items fragment and target the items container
export function listsBlock({ lists = [], selectedList = null } = {}) {
  return `
  ${lists.map(list => `
    <div class="list-item${selectedList && list.id === selectedList.id ? ' active' : ''}"
         data-id="${list.id}"
         hx-get="/api/lists/${encodeURIComponent(list.id)}/items"
         hx-target="#itemsContainer"
         hx-swap="innerHTML"
         hx-trigger="click">
      <div class="title">${escapeHtml(list.title)}</div>
      <div class="muted nowrap">${list.count ?? ''}</div>
    </div>
  `).join('')}
  `;
}

// Helper: render items as rows (fragment returned by API endpoints)
export function itemsList({ items = [] } = {}) {
  if (!items || items.length === 0) {
    return `<div class="card muted">No items</div>`;
  }

  return items.map(it => `
    <article class="item" data-id="${it.id}">
      <div class="meta">${it.due ? escapeHtml(it.due) : ''} ${it.tag ? '· ' + escapeHtml(it.tag) : ''}</div>
      <div class="title">${escapeHtml(it.title)}</div>
      <div class="actions">
        <form method="post" action="/items/${it.id}/complete" hx-post="/items/${it.id}/complete" hx-target="#itemsContainer" hx-swap="innerHTML" style="display:inline;">
          <button class="button text" type="submit">Done</button>
        </form>
        <form method="post" action="/items/${it.id}/delete" hx-post="/items/${it.id}/delete" hx-target="#itemsContainer" hx-swap="innerHTML" style="display:inline;">
          <button class="button text" type="submit">Delete</button>
        </form>
      </div>
    </article>
  `).join('');
}

// Quick add item form uses HTMX to post and replace the items region with the updated fragment
export function quickAddItemForm({ listId = '' } = {}) {
  return `
  <form id="quickAdd" class="row" method="post" action="/items"
        hx-post="/api/items"
        hx-include="#quickAdd"
        hx-target="#itemsContainer"
        hx-swap="innerHTML">
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