// Failed requests never swap away a form or clear its entered values.
const errorBox = document.getElementById("requestError");
const statusBox = document.getElementById("requestStatus");
let pending = 0;
const submittedFields = new WeakMap();
document.addEventListener("htmx:beforeRequest", event => {
  pending += 1;
  statusBox.textContent = "Loading…";
  errorBox.hidden = true;
  const form = event.detail.elt;
  submittedFields.set(event.detail.xhr, Object.fromEntries(
    (form.dataset.resetFields || "").split(" ").filter(Boolean).map(name => [name, form.elements.namedItem(name).value])
  ));
});
document.addEventListener("htmx:configRequest", event => {
  if (event.detail.elt.id !== "quickAdd") return;
  const local = event.detail.parameters.dueLocal;
  event.detail.parameters.dueDateUtc = local ? new Date(local).toISOString() : "";
});
function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}
document.addEventListener("htmx:responseError", event => {
  const { xhr } = event.detail;
  showError(xhr.status === 401 ? "Your session expired. Keep a copy of your entered text, then sign in again." :
    xhr.status >= 500 ? "The server could not finish this request. Your entered text is still here. Reload the list to check whether it saved before retrying." :
      xhr.responseText || "The request failed. Your entered text is still here.");
});
for (const name of ["htmx:sendError", "htmx:timeout"]) {
  document.addEventListener(name, () => showError("Could not reach the server. Your entered text is still here. Check the list before retrying a save."));
}
document.addEventListener("htmx:afterRequest", event => {
  pending = Math.max(0, pending - 1);
  statusBox.textContent = pending ? "Loading…" : "";
  if (!event.detail.successful) return;
  const form = event.detail.elt;
  for (const [name, value] of Object.entries(submittedFields.get(event.detail.xhr) || {})) {
    const input = form.elements.namedItem(name);
    if (input.value === value) input.value = "";
  }
  if (form.id === "quickAdd") form.elements.title.focus();
});
document.addEventListener("htmx:afterSwap", () => {
  const navigation = document.getElementById("listNavigation");
  if (navigation && !navigation.dataset.initialized) {
    navigation.open = matchMedia('(min-width: 768px)').matches;
    navigation.dataset.initialized = 'true';
  }
  const selected = document.getElementById("selectedListTitle")?.dataset.listId;
  document.querySelectorAll("#listsContainer [data-list-id]").forEach(button => {
    button.classList.toggle("active", button.dataset.listId === selected);
    button.setAttribute("aria-pressed", String(button.dataset.listId === selected));
  });
  document.querySelectorAll("time[datetime]").forEach(time => {
    const date = new Date(time.dateTime);
    if (!Number.isNaN(date.getTime())) time.textContent = date.toLocaleString();
  });
});
document.addEventListener("click", event => {
  if (event.target.closest("[data-close-settings]")) document.getElementById("settingsPanel").replaceChildren();
});
document.addEventListener("defaultsUpdated", event => {
  const listId = document.getElementById("listSelect")?.value;
  if (listId && (!event.detail.listId || event.detail.listId === listId)) {
    htmx.ajax("GET", `/api/lists/defaultOptions?listId=${encodeURIComponent(listId)}`, { target: "#quickAdd", swap: "none" });
  }
});
