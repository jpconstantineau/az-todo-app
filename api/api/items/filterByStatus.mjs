// api/items/filterByStatus.mjs
import { app } from "@azure/functions";
import { container } from "../shared/db.mjs";
import { getUserId } from "../shared/auth.mjs";
import { itemsList } from "../shared/templates.mjs";

function loadMoreButton(status, ct) {
  return `
    <div class="center" style="margin: 12px 0;">
      <button
        class="button"
        hx-get="/api/items/filterByStatus?status=${encodeURIComponent(
          status
        )}&ct=${encodeURIComponent(ct)}"
        hx-target="#items"
        hx-swap="beforeend"
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
    const status = url.searchParams.get("status") || "next";
    const ct = url.searchParams.get("ct") || undefined;

    const pageSize = 50;
    const querySpec = {
      query:
        "SELECT * FROM c WHERE c.userId=@u AND c.type='item' " +
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

    const html =
      itemsList(items) +
      (continuationToken ? loadMoreButton(status, continuationToken) : "");

    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" }
    });
  }
});