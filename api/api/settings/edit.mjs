// api/settings/edit.mjs
import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { settingsForm } from "../shared/templates.mjs";

async function getSettings(userId) {
  const { resources } = await container.items
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
  return resources[0] || null;
}

app.http("settings-edit", {
  route: "settings/edit",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const settings = await getSettings(userId);
    const html = settingsForm(settings);
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});