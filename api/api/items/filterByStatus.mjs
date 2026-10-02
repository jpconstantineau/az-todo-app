import { app } from "../shared/http.mjs";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { itemsList, esc } from "../shared/templates.mjs";
import { cleanTag, text } from "../shared/validate.mjs";

function loadMoreButton(status, ct) {
  return `
    <div class="load-more center" style="margin: 12px 0;">
      <button
        class="button"
        hx-get="/api/items/filterByStatus?status=${encodeURIComponent(
          status
        )}&ct=${encodeURIComponent(ct)}"
        hx-target="closest .load-more"
        hx-swap="outerHTML"
        aria-label="Load more items"
      >
        Load more
      </button>
    </div>
  `;
}

app.http("items-filterByStatus", {
  route: "items/filterByStatus",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async (req) => {
    const userId = getUserId(req.headers);
    if (!userId) return new Response("Unauthorized", { status: 401 });

    const url = new URL(req.url);
    const status = cleanTag(url.searchParams.get("status") || "next", "Status");
    const ct = text(url.searchParams.get("ct"), 16384, "Continuation token") || undefined;

    const pageSize = 50;
    const querySpec = {
      query:
        "SELECT * FROM c WHERE c.UserID=@u AND c.ObjectType='item' " +
        "AND c.status=@s ORDER BY c.dueDateUtc ASC",
      parameters: [
        { name: "@u", value: userId },
        { name: "@s", value: status }
      ]
    };

    const iterator = container.items.query(querySpec, {
      enableCrossPartition: true,
      maxItemCount: pageSize,
      continuationToken: ct
    });

    const { resources: items, continuationToken } = await iterator.fetchNext();

    const rows = itemsList({ items }) + (continuationToken ? loadMoreButton(status, continuationToken) : "");
    const html = ct ? rows : `<h2>Status: ${esc(status)}</h2><div id="items" class="items-table">${rows}</div>`;

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});
