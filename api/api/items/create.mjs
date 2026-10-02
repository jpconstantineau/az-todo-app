import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { listView } from "../shared/templates.mjs";
import { customAlphabet } from "nanoid";
import { checkCsrf } from "../shared/security.mjs";
import { clip, cleanTag } from "../shared/validate.mjs";

const nano = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 16);

app.http("items-create", {
  route: "items/create",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req) => {
    if (!checkCsrf(req)) return new Response("Forbidden", { status: 403 });

    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const form = await req.formData();
    const title = clip(form.get("title"), 200);
    const description = clip(form.get("description"), 4000);
    const listId = clip(form.get("listId"), 200);
    const status = clip(form.get("status") || "next", 32);
    const dueDateUtc = String(form.get("dueDateUtc") || "");
    const context = cleanTag(form.get("context"));
    const area = cleanTag(form.get("area"));
    const energy = cleanTag(form.get("energy"));
    const timeRequired = cleanTag(form.get("timeRequired"));
    const priority = cleanTag(form.get("priority"));

    if (!title || !listId) return new Response("Title and destination list are required", { status: 400 });
    if (String(form.get("title")).trim().length > 200 || String(form.get("description") || "").trim().length > 4000) {
      return new Response("Title must be at most 200 characters and description at most 4000 characters", { status: 400 });
    }
    if ((form.get("dueLocal") && !dueDateUtc) || (dueDateUtc && (!/Z$/.test(dueDateUtc) || Number.isNaN(Date.parse(dueDateUtc))))) {
      return new Response("Choose a valid due date and time", { status: 400 });
    }
    const { resources: lists } = await container.items.query({
      query: "SELECT TOP 1 * FROM c WHERE c.UserID=@u AND c.ObjectType='list' AND c.ObjectID=@l",
      parameters: [{ name: "@u", value: userId }, { name: "@l", value: listId }]
    }, { enableCrossPartition: true }).fetchAll();
    const list = lists[0];
    if (!list) return new Response("Destination list not found", { status: 404 });

    const now = new Date().toISOString();
    const id = nano();

    const doc = {
      id,
      type: "item",
      userId,
      listId,
      title,
      description,
      status,
      createdUtc: now,
      updatedUtc: now,
      dueDateUtc: dueDateUtc ? new Date(dueDateUtc).toISOString() : null,
      completedUtc: status === "completed" ? now : null,
      nextAction: status === "next",
      waitingOn: "",
      startDateUtc: null,
      reviewDateUtc: null,
      contexts: context ? [context] : [],
      areas: area ? [area] : [],
      energy: energy || null,
      timeRequired: timeRequired || null,
      priority: priority || null,
      referenceLinks: [],

      // Partition key fields (co-locate by list)
      UserID: userId,
      ObjectType: "item",
      ObjectID: listId
    };

    await container.items.create(doc);

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

    return new Response(listView({ list, items }), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});