// api/lists/create.mjs
import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { listsBlock } from "../shared/templates.mjs";
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
            "SELECT TOP 1 * FROM c WHERE c.userId=@u AND c.listId='_meta' " +
            "AND c.type='userSettings'",
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
      description: "",
      createdUtc: now,
      updatedUtc: now,
      areaTags: [],
      defaults: userDefaults
    });

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

    return new Response(listsBlock(lists), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});