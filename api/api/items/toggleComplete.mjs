import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { checkCsrf } from "../shared/security.mjs";
import { esc } from "../shared/templates.mjs";

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
    item.status = completed ? "active" : "completed";
    item.completedUtc = completed ? null : now;
    item.updatedUtc = now;

    // Replace with full partition key
    await container.item(item.id, [userId, "item", listId]).replace(item);

    const liHtml = `
      <li class="row">
        <form
          hx-post="/api/items/toggleComplete"
          hx-target="closest li"
          hx-swap="outerHTML"
        >
          <input type="hidden" name="id" value="${esc(item.id)}" />
          <input type="hidden" name="listId" value="${esc(item.listId)}" />
          <button class="button ${
            item.status === "completed" ? "success" : ""
          }" title="Toggle complete" aria-label="Toggle complete for ${esc(
      item.title
    )}">
            ${item.status === "completed" ? "✓" : "○"}
          </button>
        </form>
        <div class="max">
          <div><strong>${esc(item.title)}</strong></div>
          <div class="muted">${esc(item.description || "")}</div>
        </div>
      </li>`;
    return new Response(liHtml, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});