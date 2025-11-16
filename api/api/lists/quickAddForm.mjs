import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { quickAddItemForm } from "../shared/templates.mjs";

app.http("lists-quickAddForm", {
  route: "lists/quickAddForm",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const url = new URL(req.url);
    const listId = url.searchParams.get("listId");
    if (!listId) return new Response("listId required", { status: 400 });

    const { resources: lists } = await container.items
      .query(
        {
          query:
            "SELECT c.id, c.title, c.listId, c.defaults FROM c " +
            "WHERE c.UserID=@u AND c.ObjectType='list' ORDER BY c.updatedUtc DESC",
          parameters: [{ name: "@u", value: userId }]
        },
        { enableCrossPartition: true }
      )
      .fetchAll();

    const selected = lists.find((l) => l.listId === listId);

    let defaults = selected?.defaults;
    if (!defaults) {
      const { resources: settingsRes } = await container.items
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
      defaults = settingsRes[0]?.defaults || {
        contexts: [],
        areas: [],
        energy: [],
        timeRequired: [],
        priority: [],
        statuses: []
      };
    }

    const html = quickAddItemForm({
      lists,
      defaults,
      selectedListId: listId
    });

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});