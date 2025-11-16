// api/app/index.mjs
import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import {
  layoutShell,
  listsBlock,
  filterBar,
  itemsList,
  quickAddItemForm
} from "../shared/templates.mjs";

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
  return resources[0];
}

async function ensureSettings(userId) {
  const settings = await getSettings(userId);
  if (settings) return settings;

  const now = new Date().toISOString();
  const { defaultSettings } = await import("../shared/defaults.mjs");
  const doc = {
    id: "settings",
    type: "userSettings",
    userId,
    listId: "_meta",
    createdUtc: now,
    updatedUtc: now,
    defaults: defaultSettings
  };
  await container.items.create(doc);
  return doc;
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

    const settings = await ensureSettings(userId);

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

    const { resources: items } = await container.items
      .query(
        {
          query:
            "SELECT * FROM c WHERE c.userId=@u AND c.type='item' " +
            "AND c.status='next' ORDER BY c.dueDateUtc ASC",
          parameters: [{ name: "@u", value: userId }]
        },
        { enableCrossPartition: true }
      )
      .fetchAll();

    const listsHtml = listsBlock(lists);
    const filterBarHtml = `
      ${filterBar({ statuses: settings.defaults.statuses })}
      <div class="divider"></div>
      ${quickAddItemForm({
        lists,
        defaults: settings.defaults,
        selectedListId: lists[0]?.listId || ""
      })}
    `;
    const itemsHtml = itemsList(items);

    const html = layoutShell({
      user: userId,
      listsHtml,
      filterBarHtml,
      itemsHtml
    });

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});