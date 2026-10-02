import { readForm, text } from "../shared/validate.mjs";
import { app } from "../shared/http.mjs";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { listSettingsForm } from "../shared/templates.mjs";

async function getList(userId, listId) {
  const { resources } = await container.items
    .query(
      {
        query:
          "SELECT TOP 1 * FROM c WHERE c.UserID=@u AND c.ObjectType='list' " +
          "AND c.ObjectID=@l",
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
          "SELECT TOP 1 * FROM c WHERE c.UserID=@u AND c.ObjectType='userSettings' " +
          "AND c.ObjectID='_meta'",
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

app.http("lists-resetDefaults", {
  route: "lists/resetDefaults",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req) => {
    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const form = await readForm(req);
    const listId = text(form.get("listId"), 200, "listId");
    if (!listId) return new Response("listId required", { status: 400 });

    const list = await getList(userId, listId);
    if (!list) return new Response("Not found", { status: 404 });

    const userDefaults = await getUserDefaults(userId);
    list.defaults = userDefaults;
    list.updatedUtc = new Date().toISOString();

    await container.item(list.id, [userId, "list", listId]).replace(list);

    const html = listSettingsForm({
      list,
      effectiveDefaults: userDefaults,
      userDefaults
    });

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "HX-Trigger": JSON.stringify({ defaultsUpdated: { listId } }) }
    });
  }
});