import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { defaultSettings } from "../shared/defaults.mjs";
import { getUserId } from "../shared/auth.mjs";

app.http("settings-ensure", {
  route: "settings/ensure",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const query = {
      query:
        "SELECT TOP 1 * FROM c WHERE c.UserID=@u AND c.ObjectType='userSettings' " +
        "AND c.ObjectID='_meta'",
      parameters: [{ name: "@u", value: userId }]
    };

    const { resources } = await container.items
      .query(query, { enableCrossPartition: true })
      .fetchAll();
    if (resources.length) {
      return new Response("OK", { status: 200 });
    }

    const now = new Date().toISOString();
    await container.items.create({
      id: "settings",
      type: "userSettings",
      userId,
      listId: "_meta",

      UserID: userId,
      ObjectType: "userSettings",
      ObjectID: "_meta",

      createdUtc: now,
      updatedUtc: now,
      defaults: defaultSettings
    });

    return new Response("OK", { status: 201 });
  }
});