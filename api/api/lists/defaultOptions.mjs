import { text } from "../shared/validate.mjs";
// api/lists/defaultOptions.mjs
import { app } from "../shared/http.mjs";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";

import { defaultOptions } from "../shared/templates.mjs";

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
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const url = new URL(req.url);
    const listId = text(url.searchParams.get("listId") || url.searchParams.get("listid"), 200, "listId");
    if (!listId) return new Response("listId required", { status: 400 });

    const list = await getList(userId, listId);
    if (!list) return new Response("List not found", { status: 404 });
    const userDefaults = await getUserDefaults(userId);
    const d = list?.defaults || userDefaults;

    const html = defaultOptions(d);

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});