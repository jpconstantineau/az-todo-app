// api/shared/db.mjs
import { CosmosClient } from "@azure/cosmos";

//const endpoint = process.env.COSMOS_ENDPOINT;
//const key = process.env.COSMOS_KEY;
//if (!endpoint || !key) {
//  console.warn("COSMOS_ENDPOINT/COSMOS_KEY not set");
//}
//const client = new CosmosClient({ endpoint, key });

const databaseId = process.env.COSMOS_DB || "ToDoList";
const containerId = process.env.COSMOS_CONTAINER || "Items";

const CosmosDbConnectionSetting = process.env.CosmosDbConnectionSetting;

const client = new CosmosClient(CosmosDbConnectionSetting);

const db = client.database(databaseId);
const container = db.container(containerId);

export { client, db, container };