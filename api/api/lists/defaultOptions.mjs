// api/lists/defaultOptions.mjs
import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";

function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function opts(arr) {
  return (arr || [])
    .map((v) => `<option value="${esc(v)}">${esc(v)}</option>`)
    .join("");
}

async function getUserDefaults(userId) {
  const { resources } = await container.items
    .query(
      {
        query:
          "SELECT TOP 1 * FROM c WHERE c.UserID=@u AND c.ObjectType='userSettings' AND c.ObjectID='_meta'",
        parameters: [{ name: "@u", value: userId }]
      },
      { enableCrossPartition: true }
    )
    .fetchAll();
  return resources[0]?.defaults || {
    contexts: [],
    areas: [],
    energy: [],
    timeRequired: [],
    priority: [],
    statuses: []
  };
}

async function getList(userId, listId) {
  const { resources } = await container.items
    .query(
      {
        query:
          "SELECT TOP 1 * FROM c WHERE c.UserID=@u AND c.ObjectType='list' AND c.ObjectID=@l",
        parameters: [
          { name: "@u", value: userId },
          { name: "@l", value: listId }
        ]
      },
      { enableCrossPartition: true }
    )
    .fetchAll();
  return resources[0] || null;
}

app.http("lists-defaultOptions", {
  route: "lists/defaultOptions",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    const userId = getUserId(req.headers);
    if (!userId) return new Response("", { status: 204 });

    const url = new URL(req.url);
    const listId = url.searchParams.get("listId") || url.searchParams.get("listid");
    if (!listId) return new Response("", { status: 204 });

    const list = await getList(userId, listId);
    const userDefaults = await getUserDefaults(userId);
    const d = list?.defaults || userDefaults;

    // Return OOB swaps for each select to replace innerHTML only
    const html = `
      <select id="statusSelect" hx-swap-oob="innerHTML">${opts(d.statuses)}</select>
      <select id="contextSelect" hx-swap-oob="innerHTML">${opts(d.contexts)}</select>
      <select id="areaSelect" hx-swap-oob="innerHTML">${opts(d.areas)}</select>
      <select id="energySelect" hx-swap-oob="innerHTML">${opts(d.energy)}</select>
      <select id="timeReqSelect" hx-swap-oob="innerHTML">${opts(d.timeRequired)}</select>
      <select id="prioritySelect" hx-swap-oob="innerHTML">${opts(d.priority)}</select>
    `;

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});