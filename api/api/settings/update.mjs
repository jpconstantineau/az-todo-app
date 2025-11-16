// api/settings/update.mjs
import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { settingsForm } from "../shared/templates.mjs";
import { checkCsrf } from "../shared/security.mjs";
import { toArrayClean } from "../shared/validate.mjs";

async function loadSettings(userId) {
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

app.http("settings-update", {
  route: "settings/update",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req) => {
    if (!checkCsrf(req)) return new Response("Forbidden", { status: 403 });

    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const form = await req.formData();

    const updatedDefaults = {
      contexts: toArrayClean(form, "contexts[]"),
      areas: toArrayClean(form, "areas[]"),
      energy: toArrayClean(form, "energy[]"),
      timeRequired: toArrayClean(form, "timeRequired[]"),
      priority: toArrayClean(form, "priority[]"),
      statuses: toArrayClean(form, "statuses[]")
    };

    let doc = await loadSettings(userId);
    const now = new Date().toISOString();

    if (!doc) {
      doc = {
        id: "settings",
        type: "userSettings",
        userId,
        listId: "_meta",
        createdUtc: now,
        updatedUtc: now,
        defaults: updatedDefaults
      };
      await container.items.create(doc);
    } else {
      doc.defaults = updatedDefaults;
      doc.updatedUtc = now;
      await container.item("settings", [userId, "_meta"]).replace(doc);
    }

    return new Response(settingsForm(doc), {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});