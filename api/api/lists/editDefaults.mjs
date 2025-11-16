// api/lists/editDefaults.mjs
import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { listSettingsForm } from "../shared/templates.mjs";

async function getList(userId, listId) {
  const { resources } = await container.items
    .query(
      {
        query:
          "SELECT TOP 1 * FROM c WHERE c.userId=@u AND c.listId=@l " +
          "AND c.type='list'",
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

async function getUserDefaults(userId) {
  const { resources } = await container.items
    .query(
      {
        query:
          "SELECT TOP 1 * FROM c WHERE c.userId=@u AND c.listId='_meta' " +
          "AND c.type='userSettings'",
        parameters: [{ name: "@u", value: userId }]
      },
      { enableCrossPartition: true }
    )
    .fetchAll();
  return (
    resources[0]?.defaults || {
      contexts: [],
      areas: [],
      energy: [],
      timeRequired: [],
      priority: [],
      statuses: []
    }
  );
}

app.http("lists-editDefaults", {
  route: "lists/editDefaults",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const url = new URL(req.url);
    const listId = url.searchParams.get("listId");
    if (!listId) return new Response("listId required", { status: 400 });

    const list = await getList(userId, listId);
    if (!list) return new Response("Not found", { status: 404 });

    const userDefaults = await getUserDefaults(userId);
    const effectiveDefaults = list?.defaults || userDefaults;

    const html = listSettingsForm({
      list,
      effectiveDefaults,
      userDefaults
    });

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});