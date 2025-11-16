import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { itemsList } from "../shared/templates.mjs";
import { customAlphabet } from "nanoid";
import { checkCsrf } from "../shared/security.mjs";
import { clip, cleanTag } from "../shared/validate.mjs";

const nano = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 16);

function toUtcFromLocal(localStr) {
  if (!localStr) return null;
  const dt = new Date(localStr);
  if (isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

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
    const dueLocal = clip(form.get("dueLocal"), 32);
    const context = cleanTag(form.get("context"));
    const area = cleanTag(form.get("area"));
    const energy = cleanTag(form.get("energy"));
    const timeRequired = cleanTag(form.get("timeRequired"));
    const priority = cleanTag(form.get("priority"));

    if (!title || !listId) return new Response("Bad request", { status: 400 });

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
      dueDateUtc: toUtcFromLocal(dueLocal),
      completedUtc: null,
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

    return new Response(itemsList(items), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});