import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { listView, destinationSelect, defaultOptions } from "../shared/templates.mjs";

app.http("items-byList", {
  route: "items/byList",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const url = new URL(req.url);
    const listId = url.searchParams.get("listId");
    if (!listId) return new Response("listId required", { status: 400 });

    // All items in the list partition
    const { resources: items } = await container.items
      .query(
        {
          query:
            "SELECT * FROM c WHERE c.UserID=@u AND c.ObjectType='item' " +
            "AND c.ObjectID=@l ORDER BY c.createdUtc DESC",
          parameters: [
            { name: "@u", value: userId },
            { name: "@l", value: listId }
          ]
        },
        { enableCrossPartition: true }
      )
      .fetchAll();

    // Lists for dropdown with defaults
    const { resources: lists } = await container.items
      .query(
        {
          query:
            "SELECT c.id, c.title, c.listId, c.description, c.defaults FROM c " +
            "WHERE c.UserID=@u AND c.ObjectType='list' ORDER BY c.updatedUtc DESC",
          parameters: [{ name: "@u", value: userId }]
        },
        { enableCrossPartition: true }
      )
      .fetchAll();

    const selected = lists.find((l) => l.listId === listId);

    if (!selected) return new Response("List not found", { status: 404 });
    let defaults = selected.defaults;
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

    const html = listView({ list: selected, items }) +
      destinationSelect({ lists, selectedListId: listId, oob: true }) + defaultOptions(defaults);

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});
