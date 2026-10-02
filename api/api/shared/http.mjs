import { app as functions } from "@azure/functions";
import { getUserId } from "./auth.mjs";
import { apiHeaders, checkCsrf } from "./security.mjs";
import { ValidationError } from "./validate.mjs";

// Register all HTTP routes here so new mutations inherit the same boundary.
export const app = {
  http(name, config) {
    functions.http(name, {
      ...config,
      handler: async (req, context) => {
        let response;
        try {
          const publicShell = config.route === "app" && req.method === "GET";
          if (!publicShell && !getUserId(req.headers)) {
            response = new Response("Unauthorized", { status: 401 });
          } else if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !checkCsrf(req)) {
            response = new Response("Request origin could not be verified. Your entered text has been kept. Reload this site before retrying.", { status: 403 });
          } else {
            response = await config.handler(req, context);
          }
        } catch (error) {
          if (error instanceof ValidationError) {
            response = new Response(error.message, { status: 400 });
          } else {
            context?.error("API request failed", error);
            response = new Response("The server could not finish this request.", { status: 500 });
          }
        }
        for (const [name, value] of Object.entries(apiHeaders)) response.headers.set(name, value);
        return response;
      }
    });
  }
};
