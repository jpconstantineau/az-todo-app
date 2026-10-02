import { app } from "../shared/http.mjs";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { layoutShell } from "../shared/templates.mjs";
import { defaultSettings } from "../shared/defaults.mjs";

async function getSettings(userId) {
  const { resources } = await container.items
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
  return resources[0];
}

app.http("app-index", {
  route: "app",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    const userId = getUserId(req.headers);
    if (!userId) {
      return new Response(
        `<section class="card"><p>Please <a href="/.auth/login/github">sign in</a>.</p></section>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }

    const settings = await getSettings(userId);

    // Lists for user
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

    const html = layoutShell({ lists, defaults: settings?.defaults || defaultSettings });

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});
