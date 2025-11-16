// api/lists/all.mjs
import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { listsBlock } from "../shared/templates.mjs";

app.http("lists-all", {
  route: "lists/all",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const { resources: lists } = await container.items
      .query(
        {
          query:
            "SELECT c.id, c.title, c.listId, c.createdUtc, c.updatedUtc " +
            "FROM c WHERE c.userId=@u AND c.type='list' " +
            "ORDER BY c.updatedUtc DESC",
          parameters: [{ name: "@u", value: userId }]
        },
        { enableCrossPartition: true }
      )
      .fetchAll();

    const html = listsBlock(lists);
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});