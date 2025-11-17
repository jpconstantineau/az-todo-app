// api/shared/templates.mjs
export function esc(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function layoutShell({ user, listsHtml, filterBarHtml, itemsHtml }) {
  return `
  <div class="grid">
    <div class="s12 m4 l3">
      <section class="card">
        <header class="space">
          <h6 class="max">Lists</h6>
          <form
            hx-post="/api/lists/create"
            hx-target="#lists"
            hx-swap="innerHTML"
            class="row"
          >
            <input
              type="text"
              name="title"
              placeholder="New list…"
              required
              class="max"
            />
            <button class="button primary" aria-label="Add list">Add</button>
          </form>
        </header>
        <div id="lists">${listsHtml}</div>
      </section>
    </div>
    <div class="s12 m8 l9">
      <section class="card">
        <header class="space">
          <h6 class="max">Items</h6>
          <button
            class="button text"
            hx-get="/api/settings/edit"
            hx-target="#items"
            hx-swap="innerHTML"
            title="Edit Settings"
            aria-label="Edit Settings"
          >
            Settings
          </button>
          ${filterBarHtml}
        </header>
        <div id="items">${itemsHtml}</div>
      </section>
    </div>
  </div>`;
}

export function listsBlock(lists) {
  if (!lists?.length) {
    return `<div class="muted">No lists yet. Create one above.</div>`;
  }
  return `
  <ul class="list">
    ${lists
      .map(
        (l) => `
      <li>
        <div class="row hover">
          <a
            class="button text"
            hx-get="/api/items/byList?listId=${encodeURIComponent(
              l.listId
            )}"
            hx-target="#items"
            hx-swap="innerHTML"
            title="Open list"
            aria-label="Open list ${esc(l.title)}"
          >
            <span class="max">${esc(l.title)}</span>
          </a>
          <button
            class="button text"
            title="List settings"
            aria-label="List settings for ${esc(l.title)}"
            hx-get="/api/lists/editDefaults?listId=${encodeURIComponent(
              l.listId
            )}"
            hx-target="#items"
            hx-swap="innerHTML"
          >⚙</button>
          <small class="muted nowrap">${new Date(
            l.updatedUtc || l.createdUtc
          ).toLocaleDateString()}</small>
        </div>
      </li>`
      )
      .join("")}
  </ul>`;
}

export function filterBar({ statuses }) {
  const opts = statuses.map(
    (s) => `<option value="${esc(s)}">${esc(s)}</option>`
  );
  return `
  <form
    class="row"
    hx-get="/api/items/filterByStatus"
    hx-target="#items"
    hx-swap="innerHTML"
  >
    <select name="status" class="max" aria-label="Status filter">
      ${opts.join("")}
    </select>
    <button class="button" aria-label="Filter">Filter</button>
  </form>`;
}

export function itemsList(items) {
  if (!items?.length) return `<div class="muted">No items.</div>`;
  return `
  <ul class="list">
    ${items
      .map((it) => {
        const done = it.status === "completed";
        const due = it.dueDateUtc
          ? new Date(it.dueDateUtc).toLocaleString()
          : "";
        return `
        <li class="row">
          <form
            hx-post="/api/items/toggleComplete"
            hx-target="closest li"
            hx-swap="outerHTML"
          >
            <input type="hidden" name="id" value="${esc(it.id)}" />
            <input type="hidden" name="listId" value="${esc(it.listId)}" />
            <button
              class="button ${done ? "success" : ""}"
              title="Toggle complete"
              aria-label="Toggle complete for ${esc(it.title)}"
            >
              ${done ? "✓" : "○"}
            </button>
          </form>
          <div class="max">
            <div><strong>${esc(it.title)}</strong></div>
            <div class="muted">${esc(it.description || "")}</div>
            <div>
              ${
                it.contexts
                  ?.map((c) => `<span class="chip">${esc(c)}</span>`)
                  .join("") || ""
              }
              ${
                it.areas
                  ?.map((a) => `<span class="chip">${esc(a)}</span>`)
                  .join("") || ""
              }
              ${
                it.energy
                  ? `<span class="chip">Energy: ${esc(it.energy)}</span>`
                  : ""
              }
              ${
                it.timeRequired
                  ? `<span class="chip">Time: ${esc(it.timeRequired)}</span>`
                  : ""
              }
              ${
                it.priority
                  ? `<span class="chip">Pri: ${esc(it.priority)}</span>`
                  : ""
              }
              ${due ? `<span class="chip">Due: ${esc(due)}</span>` : ""}
            </div>
          </div>
        </li>`;
      })
      .join("")}
  </ul>`;
}

export function quickAddItemForm({
  lists,
  defaults,
  selectedListId = ""
}) {
  const listOpts = lists
    .map(
      (l) =>
        `<option value="${esc(l.listId)}" ${
          selectedListId === l.listId ? "selected" : ""
        }>${esc(l.title)}</option>`
    )
    .join("");

  const opts = (arr) =>
    arr.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("");

  return `
  <form
    class="row"
    hx-post="/api/items/create"
    hx-target="#items"
    hx-swap="innerHTML"
  >
    <div class="field s12 l6">
      <label for="qaTitle">Title</label>
      <input
        id="qaTitle"
        class="max"
        type="text"
        name="title"
        placeholder="New item title"
        required
        autocomplete="off"
        aria-label="New item title"
      />
    </div>

    <div class="field s12 m6 l6">
      <label for="qaList">List</label>
      <select
        id="qaList"
        name="listId"
        aria-label="Select list"
        hx-get="/api/lists/defaultOptions"
        hx-trigger="change"
        hx-vals='js:{ listId: this.value }'
        hx-swap="none"
        hx-sync="closest form:abort"
      >${listOpts}</select>
    </div>

    <div class="field s12 m6 l4">
      <label for="statusSelect">Status</label>
      <select id="statusSelect" name="status" aria-label="Status">
        ${opts(defaults.statuses)}
      </select>
    </div>

    <div class="field s12 m6 l4">
      <label for="qaDue">Due</label>
      <input
        id="qaDue"
        type="datetime-local"
        name="dueLocal"
        aria-label="Due date/time"
        autocomplete="off"
      />
    </div>

    <div class="field s12 m6 l4">
      <label for="contextSelect">Context</label>
      <select id="contextSelect" name="context" aria-label="Context">
        ${opts(defaults.contexts)}
      </select>
    </div>

    <div class="field s12 m6 l4">
      <label for="areaSelect">Area of Focus</label>
      <select id="areaSelect" name="area" aria-label="Area of Focus">
        ${opts(defaults.areas)}
      </select>
    </div>

    <div class="field s12 m6 l4">
      <label for="energySelect">Energy</label>
      <select id="energySelect" name="energy" aria-label="Energy">
        ${opts(defaults.energy)}
      </select>
    </div>

    <div class="field s12 m6 l4">
      <label for="timeReqSelect">Time required</label>
      <select id="timeReqSelect" name="timeRequired" aria-label="Time required">
        ${opts(defaults.timeRequired)}
      </select>
    </div>

    <div class="field s12 m6 l4">
      <label for="prioritySelect">Priority</label>
      <select id="prioritySelect" name="priority" aria-label="Priority">
        ${opts(defaults.priority)}
      </select>
    </div>

    <div class="s12">
      <button class="button primary" aria-label="Add item">Add</button>
    </div>
  </form>`;
}

export function settingsForm(settings) {
  const d = settings?.defaults || {
    contexts: [],
    areas: [],
    energy: [],
    timeRequired: [],
    priority: [],
    statuses: []
  };
  const group = (label, name, values = []) => {
    const rows = values
      .map(
        (v) => `
        <div class="row" data-row>
          <input class="max" type="text" name="${name}[]" value="${esc(v)}" />
          <button type="button" class="button text" data-remove-row
            title="Remove">Remove</button>
        </div>`
      )
      .join("");
    return `
      <section class="card">
        <header class="space">
          <h6 class="max">${esc(label)}</h6>
          <button type="button" class="button" data-add-row="${esc(
            name
          )}">Add</button>
        </header>
        <div class="${esc(name)}-group">
          ${rows || '<div class="muted">No values</div>'}
        </div>
      </section>
    `;
  };

  return `
  <section class="card">
    <header class="space">
      <h6 class="max">Settings</h6>
      <div class="row">
        <button
          class="button"
          hx-post="/api/settings/reset"
          hx-target="#items"
          hx-swap="innerHTML"
        >Reset to defaults</button>
      </div>
    </header>

    <form
      hx-post="/api/settings/update"
      hx-target="#items"
      hx-swap="innerHTML"
    >
      ${group("Contexts", "contexts", d.contexts)}
      ${group("Areas of Focus", "areas", d.areas)}
      ${group("Energy Levels", "energy", d.energy)}
      ${group("Time Required", "timeRequired", d.timeRequired)}
      ${group("Priority", "priority", d.priority)}
      ${group("Statuses", "statuses", d.statuses)}

      <div class="row right-align">
        <button class="button primary">Save Settings</button>
        <button
          class="button text"
          type="button"
          hx-get="/api/items/filterByStatus?status=next"
          hx-target="#items"
          hx-swap="innerHTML"
        >Back to Items</button>
      </div>
    </form>
  </section>
  <script>
    (function () {
      const root = document.currentScript.closest("#items");
      if (!root) return;
      root.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-remove-row]");
        if (btn) {
          const row = btn.closest("[data-row]");
          if (row) row.remove();
        }
        const add = e.target.closest("[data-add-row]");
        if (add) {
          const name = add.getAttribute("data-add-row");
          const group = root.querySelector("." + name + "-group");
          if (group) {
            if (
              group.firstElementChild &&
              group.firstElementChild.classList.contains("muted")
            ) {
              group.innerHTML = "";
            }
            const div = document.createElement("div");
            div.className = "row";
            div.setAttribute("data-row", "");
            div.innerHTML = \`
              <input class="max" type="text" name="\${name}[]" value="" />
              <button type="button" class="button text"
                data-remove-row title="Remove">Remove</button>
            \`;
            group.appendChild(div);
          }
        }
      });
    })();
  </script>
  `;
}

export function listSettingsForm({
  list,
  effectiveDefaults,
  userDefaults
}) {
  const d = list?.defaults || effectiveDefaults;
  const group = (label, name, values = []) => {
    const rows = values
      .map(
        (v) => `
        <div class="row" data-row>
          <input class="max" type="text" name="${name}[]" value="${esc(v)}" />
          <button type="button" class="button text" data-remove-row>
            Remove
          </button>
        </div>`
      )
      .join("");
    return `
      <section class="card">
        <header class="space">
          <h6 class="max">${esc(label)}</h6>
          <button type="button" class="button" data-add-row="${esc(
            name
          )}">Add</button>
        </header>
        <div class="${esc(name)}-group">
          ${rows || '<div class="muted">No values</div>'}
        </div>
      </section>
    `;
  };

  return `
  <section class="card">
    <header class="space">
      <h6 class="max">List Settings — ${esc(list?.title || "")}</h6>
      <div class="row">
        <form
          hx-post="/api/lists/resetDefaults"
          hx-target="#items"
          hx-swap="innerHTML"
          class="row"
        >
          <input type="hidden" name="listId" value="${esc(list.listId)}" />
          <button class="button">Reset to user defaults</button>
        </form>
      </div>
    </header>
    <form
      hx-post="/api/lists/updateDefaults"
      hx-target="#items"
      hx-swap="innerHTML"
    >
      <input type="hidden" name="listId" value="${esc(list.listId)}" />
      ${group("Contexts", "contexts", d.contexts)}
      ${group("Areas of Focus", "areas", d.areas)}
      ${group("Energy Levels", "energy", d.energy)}
      ${group("Time Required", "timeRequired", d.timeRequired)}
      ${group("Priority", "priority", d.priority)}
      ${group("Statuses", "statuses", d.statuses)}
      <div class="row right-align">
        <button class="button primary">Save List Settings</button>
        <button
          class="button text"
          type="button"
          hx-get="/api/items/byList?listId=${esc(list.listId)}"
          hx-target="#items"
          hx-swap="innerHTML"
        >Back to List</button>
      </div>
    </form>
  </section>
  <script>
    (function () {
      const root = document.currentScript.closest("#items");
      if (!root) return;
      root.addEventListener("click", (e) => {
        const rm = e.target.closest("[data-remove-row]");
        if (rm) {
          e.preventDefault();
          const row = rm.closest("[data-row]");
          if (row) row.remove();
        }
        const add = e.target.closest("[data-add-row]");
        if (add) {
          e.preventDefault();
          const name = add.getAttribute("data-add-row");
          const group = root.querySelector("." + name + "-group");
          if (group) {
            if (
              group.firstElementChild &&
              group.firstElementChild.classList.contains("muted")
            ) {
              group.innerHTML = "";
            }
            const div = document.createElement("div");
            div.className = "row";
            div.setAttribute("data-row", "");
            div.innerHTML = \`
              <input class="max" type="text" name="\${name}[]" value="" />
              <button type="button" class="button text" data-remove-row>
                Remove
              </button>
            \`;
            group.appendChild(div);
          }
        }
      });
    })();
  </script>
  `;
}