// api/settings/ensure.mjs
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

    const id = "settings";
    const listId = "_meta";
    const type = "userSettings";

    const query = {
      query:
        "SELECT TOP 1 * FROM c WHERE c.userId=@u AND c.listId=@l AND c.type=@t",
      parameters: [
        { name: "@u", value: userId },
        { name: "@l", value: listId },
        { name: "@t", value: type }
      ]
    };

    const { resources } = await container.items
      .query(query, { enableCrossPartition: true })
      .fetchAll();
    if (resources.length) {
      return new Response("OK", { status: 200 });
    }

    const now = new Date().toISOString();
    await container.items.create({
      id,
      type,
      userId,
      listId,
      createdUtc: now,
      updatedUtc: now,
      defaults: defaultSettings
    });

    return new Response("OK", { status: 201 });
  }
});