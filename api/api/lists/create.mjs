import { app } from "../shared/http.mjs";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { listsBlock, destinationSelect, listView, defaultOptions } from "../shared/templates.mjs";
import { customAlphabet } from "nanoid";
import { defaultSettings } from "../shared/defaults.mjs";
import { text, requireNonEmpty, readForm } from "../shared/validate.mjs";

const nano = customAlphabet("1234567890abcdefghijklmnopqrstuvwxyz", 12);

app.http("lists-create", {
  route: "lists/create",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req) => {
    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const form = await readForm(req);
    const rawTitle = form.get("title");
    const title = text(rawTitle, 200, "Title");
    const description = text(form.get("description"), 4000, "Description");
    requireNonEmpty(title, "Title");

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
      description,
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
      `<section id="itemsView" hx-swap-oob="innerHTML">${listView({ list: { ...list, description } })}</section>` + defaultOptions(userDefaults);
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});
