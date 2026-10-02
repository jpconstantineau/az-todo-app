import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { checkCsrf } from "../shared/security.mjs";
import { itemRow } from "../shared/templates.mjs";

app.http("items-toggleComplete", {
  route: "items/toggleComplete",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req) => {
    if (!checkCsrf(req)) return new Response("Forbidden", { status: 403 });

    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const form = await req.formData();
    const id = (form.get("id") || "").toString();
    const listId = (form.get("listId") || "").toString();
    if (!id || !listId) return new Response("Bad request", { status: 400 });

    // Query (could be point-read if we had ObjectType handy; we do)
    const { resources } = await container.items
      .query(
        {
          query:
            "SELECT TOP 1 * FROM c WHERE c.UserID=@u AND c.ObjectType='item' " +
            "AND c.ObjectID=@l AND c.id=@id",
          parameters: [
            { name: "@u", value: userId },
            { name: "@l", value: listId },
            { name: "@id", value: id }
          ]
        },
        { enableCrossPartition: true }
      )
      .fetchAll();
    const item = resources[0];
    if (!item) return new Response("Not found", { status: 404 });

    const now = new Date().toISOString();
    const completed = item.status === "completed";
    if (!completed) item.statusBeforeCompletion = item.status;
    item.status = completed ? (item.statusBeforeCompletion || "next") : "completed";
    item.nextAction = item.status === "next";
    item.completedUtc = completed ? null : now;
    item.updatedUtc = now;

    // Replace with full partition key
    await container.item(item.id, [userId, "item", listId]).replace(item);

    return new Response(itemRow(item), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});