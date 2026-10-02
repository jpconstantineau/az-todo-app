import { app } from "../shared/http.mjs";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { listSettingsForm } from "../shared/templates.mjs";
import { toArrayClean, readForm, text } from "../shared/validate.mjs";

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

app.http("lists-updateDefaults", {
  route: "lists/updateDefaults",
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

    const defaults = {
      contexts: toArrayClean(form, "contexts[]"),
      areas: toArrayClean(form, "areas[]"),
      energy: toArrayClean(form, "energy[]"),
      timeRequired: toArrayClean(form, "timeRequired[]"),
      priority: toArrayClean(form, "priority[]"),
      statuses: toArrayClean(form, "statuses[]")
    };

    list.defaults = defaults;
    list.updatedUtc = new Date().toISOString();

    // point replace with full partition key
    await container.item(list.id, [userId, "list", listId]).replace(list);

    const html = listSettingsForm({
      list,
      effectiveDefaults: defaults,
      userDefaults: defaults
    });

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "HX-Trigger": JSON.stringify({ defaultsUpdated: { listId } }) }
    });
  }
});