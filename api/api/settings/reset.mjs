import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { defaultSettings } from "../shared/defaults.mjs";
import { settingsForm, options } from "../shared/templates.mjs";
import { checkCsrf } from "../shared/security.mjs";

app.http("settings-reset", {
  route: "settings/reset",
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (req) => {
    if (!checkCsrf(req)) return new Response("Forbidden", { status: 403 });

    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const now = new Date().toISOString();
    const doc = {
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
    };

    try {
      await container.item("settings", [userId, "userSettings", "_meta"]).replace(doc);
    } catch {
      await container.items.create(doc);
    }

    return new Response(settingsForm({ settings: doc }) + `<select id="statusFilterSelect" name="status" hx-swap-oob="outerHTML">${options([...new Set(["next", ...doc.defaults.statuses])], "next", false)}</select>`, {
      headers: { "content-type": "text/html; charset=utf-8", "HX-Trigger": "defaultsUpdated" }
    });
  }
});