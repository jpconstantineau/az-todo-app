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
        const jsonRoute = config.route.startsWith("v1/") || config.route.startsWith("shared/");
        const failure = (message, status, error) => jsonRoute
          ? new Response(JSON.stringify({ apiVersion: 1, error, message }), { status, headers: { "content-type": "application/json; charset=utf-8" } })
          : new Response(message, { status });
        try {
          if (!getUserId(req.headers)) {
            response = failure("Unauthorized", 401, "unauthorized");
          } else if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !checkCsrf(req)) {
            response = failure("Request origin could not be verified. Your entered text has been kept. Reload this site before retrying.", 403, "untrusted_origin");
          } else {
            response = await config.handler(req, context);
          }
        } catch (error) {
          if (error instanceof ValidationError) {
            response = failure(error.message, 400, "invalid_request");
          } else {
            context?.error("API request failed", error);
            response = failure("The server could not finish this request.", 500, "server_error");
          }
        }
        for (const [name, value] of Object.entries(apiHeaders)) response.headers.set(name, value);
        return response;
      }
    });
  }
};
