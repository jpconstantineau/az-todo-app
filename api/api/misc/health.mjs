import { app } from "@azure/functions";

app.http("misc-health", {
  route: "health",
  methods: ["GET"],
  authLevel: "anonymous",
  handler: async () => {
    return new Response("OK", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
});