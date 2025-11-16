// api/shared/db.mjs
import { CosmosClient } from "@azure/cosmos";

const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = process.env.COSMOS_DB || "gtd";
const containerId = process.env.COSMOS_CONTAINER || "gtd";

if (!endpoint || !key) {
  console.warn("COSMOS_ENDPOINT/COSMOS_KEY not set");
}

const client = new CosmosClient({ endpoint, key });
const db = client.database(databaseId);
const container = db.container(containerId);

export { client, db, container };