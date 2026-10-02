import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { listsBlock, destinationSelect, listView, defaultOptions } from "../shared/templates.mjs";
import { customAlphabet } from "nanoid";
import { defaultSettings } from "../shared/defaults.mjs";
import { checkCsrf } from "../shared/security.mjs";
import { clip, requireNonEmpty } from "../shared/validate.mjs";

const nano = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 12);

app.http("lists-create", {
  route: "lists/create",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req) => {
    if (!checkCsrf(req)) return new Response("Forbidden", { status: 403 });

    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const form = await req.formData();
    const rawTitle = form.get("title");
    const title = clip(rawTitle, 200);
    if (String(rawTitle || "").trim().length > 200 || String(form.get("description") || "").trim().length > 4000) {
      return new Response("Title must be at most 200 characters and description at most 4000 characters", { status: 400 });
    }
    try {
      requireNonEmpty(title, "Title");
    } catch (resp) {
      return resp;
    }

    const now = new Date().toISOString();
    const listId = nano();

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
    const userDefaults = settingsRes[0]?.defaults || defaultSettings;

    await container.items.create({
      id: listId,
      type: "list",
      userId,
      listId,
      title,
      description: clip(form.get("description"), 4000),
      createdUtc: now,
      updatedUtc: now,
      areaTags: [],
      defaults: userDefaults,

      // Partition key fields
      UserID: userId,
      ObjectType: "list",
      ObjectID: listId
    });

    const { resources: lists } = await container.items
      .query(
        {
          query:
            "SELECT c.id, c.title, c.listId, c.createdUtc, c.updatedUtc " +
            "FROM c WHERE c.UserID=@u AND c.ObjectType='list' " +
            "ORDER BY c.updatedUtc DESC",
          parameters: [{ name: "@u", value: userId }]
        },
        { enableCrossPartition: true }
      )
      .fetchAll();

    const list = lists.find(list => list.id === listId);
    const html = listsBlock({ lists }) +
      destinationSelect({ lists, selectedListId: listId, oob: true }) +
      `<section id="itemsView" hx-swap-oob="innerHTML">${listView({ list: { ...list, description: clip(form.get("description"), 4000) } })}</section>` + defaultOptions(userDefaults);
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});
