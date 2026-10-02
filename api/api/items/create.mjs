import { app } from "../shared/http.mjs";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { listView } from "../shared/templates.mjs";
import { customAlphabet } from "nanoid";
import { text, cleanTag, readForm, utcDate } from "../shared/validate.mjs";
import { defaultSettings } from "../shared/defaults.mjs";

const nano = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 16);

app.http("items-create", {
  route: "items/create",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req) => {
    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const form = await readForm(req);
    const title = text(form.get("title"), 200, "Title");
    const description = text(form.get("description"), 4000, "Description");
    const listId = text(form.get("listId"), 200, "listId");
    const status = cleanTag(form.get("status") || "next", "Status");
    const dueDateUtc = utcDate(form.get("dueDateUtc"));
    const context = cleanTag(form.get("context"), "Context");
    const area = cleanTag(form.get("area"), "Area");
    const energy = cleanTag(form.get("energy"), "Energy");
    const timeRequired = cleanTag(form.get("timeRequired"), "Time required");
    const priority = cleanTag(form.get("priority"), "Priority");

    if (!title || !listId) return new Response("Title and destination list are required", { status: 400 });
    if (form.get("dueLocal") && !dueDateUtc) {
      return new Response("Choose a valid due date and time", { status: 400 });
    }
    const { resources: lists } = await container.items.query({
      query: "SELECT TOP 1 * FROM c WHERE c.UserID=@u AND c.ObjectType='list' AND c.ObjectID=@l",
      parameters: [{ name: "@u", value: userId }, { name: "@l", value: listId }]
    }, { enableCrossPartition: true }).fetchAll();
    const list = lists[0];
    if (!list) return new Response("Destination list not found", { status: 404 });

    let defaults = list.defaults;
    if (!defaults) {
      const { resources } = await container.items.query({
        query: "SELECT TOP 1 * FROM c WHERE c.UserID=@u AND c.ObjectType='userSettings' AND c.ObjectID='_meta'",
        parameters: [{ name: "@u", value: userId }]
      }, { enableCrossPartition: true }).fetchAll();
      defaults = resources[0]?.defaults || defaultSettings;
    }
    if (!["next", ...(defaults.statuses || [])].includes(status)) {
      return new Response("Status must be one of the destination list's status options.", { status: 400 });
    }

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
