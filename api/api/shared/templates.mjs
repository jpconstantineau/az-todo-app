import { defaultSettings } from "./defaults.mjs";

export function esc(value = "") {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
const fields = [
  ["contexts", "Context", "context", "contextSelect"],
  ["areas", "Area", "area", "areaSelect"],
  ["energy", "Energy", "energy", "energySelect"],
  ["timeRequired", "Time required", "timeRequired", "timeReqSelect"],
  ["priority", "Priority", "priority", "prioritySelect"],
  ["statuses", "Status", "status", "statusSelect"]
];
export function options(values = [], selected = "", optional = true) {
  return (optional ? `<option value=""${selected === "" ? " selected" : ""}>None</option>` : "") + values.map(value =>
    `<option value="${esc(value)}"${value === selected ? " selected" : ""}>${esc(value)}</option>`).join("");
}
function fieldOptions(defaults, key) {
  return options(key === "statuses" ? [...new Set(["next", ...(defaults[key] || [])])] : defaults[key], key === "statuses" ? "next" : "", key !== "statuses");
}
export function defaultOptions(defaults = {}) {
  return fields.map(([key, , name, id]) => `<select id="${id}" name="${name}" hx-swap-oob="outerHTML">${fieldOptions(defaults, key)}</select>`).join("");
}
export function listOptions(lists = [], selectedListId = "") {
  return '<option value="">Choose a list</option>' + lists.map(list =>
    `<option value="${esc(list.id)}"${list.id === selectedListId ? " selected" : ""}>${esc(list.title)}</option>`).join("");
}
export function destinationSelect({ lists = [], selectedListId = "", oob = false } = {}) {
  return `<select id="listSelect" name="listId" required hx-get="/api/items/byList" hx-trigger="change" hx-target="#itemsView"${oob ? ' hx-swap-oob="outerHTML"' : ""}>${listOptions(lists, selectedListId)}</select>`;
}
// Fragment only: html/index.html owns the document and #app target.
export function layoutShell({ lists = [], defaults = defaultSettings } = {}) {
  return `<header class="app-header"><div><p class="eyebrow">Your workspace</p><h1>To-Do</h1></div><nav class="row" aria-label="Account">
    <label class="appearance">Appearance<select data-appearance><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
    <button class="button" hx-get="/api/settings/edit" hx-target="#settingsPanel">Settings</button>
    <a class="button" href="/.auth/logout">Sign out</a></nav></header>
    <div class="app-grid"><aside class="sidebar card"><details id="listNavigation" open><summary>Lists</summary>
      <div id="listsContainer" class="lists">${listsBlock({ lists })}</div>
      <details id="createList"><summary>Create a list</summary>
      <form id="addListForm" hx-post="/api/lists/create" hx-target="#listsContainer" data-reset-fields="title description" hx-disabled-elt="find button">
        <label>List title<input name="title" required maxlength="200"></label>
        <label>Description<textarea name="description" maxlength="4000"></textarea></label>
        <button class="button primary" type="submit">Create list</button>
      </form></details></details>
    </aside><main id="main" class="main" tabindex="-1">
      <section id="settingsPanel" aria-label="Settings"></section>
      <section class="card" aria-labelledby="quickAddTitle"><p class="eyebrow">Capture</p><h2 id="quickAddTitle">Add an item</h2>
        <div id="quickAddContainer">${quickAddItemForm({ lists, defaults })}</div>
      </section>${filterBar({ statuses: defaults.statuses })}
      <section id="itemsView" class="card" aria-live="polite"><p class="eyebrow">Your work</p><h2>Choose a list or a status</h2><p>Your saved items will appear here.</p></section>
    </main></div>`;
}
export function listsBlock({ lists = [] } = {}) {
  if (!lists.length) return '<p class="muted">No lists yet. Choose “Create a list” to get started.</p>';
  return lists.map(list => `<button class="list-item button" data-list-id="${esc(list.id)}"
    hx-get="/api/items/byList?listId=${esc(encodeURIComponent(list.id))}" hx-target="#itemsView">${esc(list.title)}</button>`).join("");
}
export function itemRow(item) {
  const complete = item.status === "completed";
  return `<article class="item" data-id="${esc(item.id)}">
    <div class="item-content"><strong>${esc(item.title)}</strong><p class="description">${esc(item.description)}</p>
      <div class="meta">${esc(item.status)}${item.dueDateUtc ? ` · Due <time datetime="${esc(item.dueDateUtc)}">${esc(item.dueDateUtc)}</time>` : ""}</div>
      <div class="meta">${[...(item.contexts || []), ...(item.areas || []), item.energy, item.timeRequired, item.priority].filter(Boolean).map(esc).join(" · ")}</div>
    </div><form hx-post="/api/items/toggleComplete" hx-target="closest article" hx-swap="outerHTML" hx-disabled-elt="find button">
      <input type="hidden" name="id" value="${esc(item.id)}"><input type="hidden" name="listId" value="${esc(item.listId)}">
      <button class="button ${complete ? "success" : ""}" type="submit" aria-label="${complete ? "Reopen" : "Complete"} ${esc(item.title)}">${complete ? "Reopen" : "Complete"}</button>
    </form></article>`;
}
export function itemsList({ items = [] } = {}) {
  return items.length ? items.map(itemRow).join("") : '<p class="muted">No items in this view.</p>';
}
export function listView({ list, items = [] }) {
  return `<p class="eyebrow">Your work</p><h2 id="selectedListTitle" data-list-id="${esc(list.id)}">${esc(list.title)}</h2>
    <p class="description">${esc(list.description)}</p>
    <button class="button" hx-get="/api/lists/editDefaults?listId=${esc(encodeURIComponent(list.id))}" hx-target="#settingsPanel">List defaults</button>
    <div id="items" class="items-table">${itemsList({ items })}</div>`;
}
export function quickAddItemForm({ lists = [], defaults = defaultSettings, selectedListId = "" } = {}) {
  return `<form id="quickAdd" hx-post="/api/items/create" hx-target="#itemsView" data-reset-fields="title description dueLocal" hx-disabled-elt="#quickAdd button">
    <div class="form-grid"><label>Title<input name="title" required maxlength="200" placeholder="What needs doing?"></label>
    <label>Destination list${destinationSelect({ lists, selectedListId })}</label></div>
    <details class="capture-options"><summary>Description, due date &amp; details</summary>
    <label>Description<textarea name="description" maxlength="4000"></textarea></label>
    <div class="form-grid"><label>Due (your local time)<input type="datetime-local" name="dueLocal"></label>
    ${fields.map(([key, label, name, id]) => `<label class="field">${label}<select id="${id}" name="${name}">${fieldOptions(defaults, key)}</select></label>`).join("")}</div>
    </details><button class="button primary" type="submit">Add item</button>
  </form>`;
}
export function filterBar({ statuses = defaultSettings.statuses } = {}) {
  return `<form class="row filter-bar" hx-get="/api/items/filterByStatus" hx-target="#itemsView"><label>Across all lists
    <select id="statusFilterSelect" name="status">${options([...new Set(["next", ...statuses])], "next", false)}</select></label><button class="button" type="submit">Filter by status</button></form>`;
}
function defaultsFields(defaults) {
  return '<p>Enter one option per line. Empty fields remove all options for that field.</p><div class="form-grid">' + fields.map(([key, label]) =>
    `<label>${label} options<textarea name="${key}[]" rows="3">${esc((defaults[key] || []).join("\n"))}</textarea></label>`).join("") + '</div>';
}
export function listSettingsForm({ list = {}, effectiveDefaults = defaultSettings } = {}) {
  return `<section class="card"><h2>Defaults for ${esc(list.title)}</h2>
    <form hx-post="/api/lists/updateDefaults" hx-target="#settingsPanel" hx-disabled-elt="find button"><input type="hidden" name="listId" value="${esc(list.id)}">
      ${defaultsFields(effectiveDefaults)}<button class="button primary" type="submit">Save list defaults</button></form>
    <form hx-post="/api/lists/resetDefaults" hx-target="#settingsPanel" hx-disabled-elt="find button"><input type="hidden" name="listId" value="${esc(list.id)}"><button class="button" type="submit">Copy user defaults</button></form>
    <button class="button" type="button" data-close-settings>Close settings</button></section>`;
}
export function settingsForm({ settings } = {}) {
  return `<section class="card"><h2>User defaults</h2>
    <form hx-post="/api/settings/update" hx-target="#settingsPanel" hx-disabled-elt="find button">${defaultsFields(settings?.defaults || defaultSettings)}<button class="button primary" type="submit">Save user defaults</button></form>
    <form hx-post="/api/settings/reset" hx-target="#settingsPanel" hx-disabled-elt="find button"><button class="button" type="submit">Reset user defaults</button></form>
    <button class="button" type="button" data-close-settings>Close settings</button></section>`;
}
