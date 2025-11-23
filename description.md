# GTD To‑Do (Azure Static Web Apps + Functions + Cosmos DB + htmx)

A simple, extensible GTD-style to‑do list manager built for Azure Static Web Apps with an Azure Functions (Node.js v4, ESM) backend, htmx for dynamic UX (server-rendered partials), BeerCSS for styling, and Cosmos DB (SQL API) for storage.

This document summarizes scope, design philosophy, architecture, deployment, configuration, and operational guidance. It is intended to help GitHub Copilot Agent Mode and contributors understand and work within the project.

---

## Goals and Scope

- Personal, user-scoped to-do lists with GTD attributes
- Create lists and add items; mark items complete
- Per-user defaults and per-list override defaults (inheritance)
- GTD-friendly fields: contexts, areas of focus, energy level, time required, priority, statuses, next-action, waiting-on, defer/start, review/tickler, due/completed dates
- Dynamic UI using htmx with HTML partials, minimal JS, no heavy frontend frameworks
- Hosted on Azure Static Web Apps with Functions API and Cosmos DB (SQL API)

Non-goals / Exclusions

- No multi-tenant sharing across users (lists are private to each GitHub-authenticated user)
- No heavy client-side frameworks or build tooling (vanilla ESM Functions + htmx + BeerCSS)
- No complex offline sync or push notifications (future enhancement)
- No status-based partitioning (explicitly excluded)

---

## High-Level Architecture

- Static app: index.html hosted by Azure Static Web Apps (SWA)
- API backend: Azure Functions v4 (Node 18/20, ESM modules)
  - Single entry module `api/index.mjs` imports and registers all functions
  - Server-rendered HTML partials for htmx swaps
- Data store: Azure Cosmos DB (SQL API)
  - Single container with hierarchical partition key: `/UserID`, `/ObjectType`, `/ObjectID`
- Authentication: SWA built-in GitHub auth
  - Use `clientPrincipal.userId` as the stable per-user identifier
- Styling: BeerCSS via CDN
- Dynamic behavior: htmx via CDN
- Deployment: GitHub Actions to SWA

---

## Data Model and Partitioning

Single Cosmos DB container, hierarchical PK: `/UserID`, `/ObjectType`, `/ObjectID` (exact casing required).

Document shapes and PK mapping:

- Lists (type "list")
  - PK: `[UserID=userId, ObjectType="list", ObjectID=listId]`
  - Fields: `id (listId)`, `title`, `description`, `defaults (per-list)`, timestamps, `userId`, `listId` (convenience)
- Items (type "item")
  - PK: `[UserID=userId, ObjectType="item", ObjectID=listId]`
  - Fields: `id`, `title`, `description`, `status`, `createdUtc`, `updatedUtc`, `dueDateUtc`, `completedUtc`, `contexts[]`, `areas[]`, `energy`, `timeRequired`, `priority`, `nextAction`, `waitingOn`, `startDateUtc`, `reviewDateUtc`, `referenceLinks[]`, `userId`, `listId`
  - Note: Items are co-located per list by using `ObjectID=listId`
- User Settings (type "userSettings")
  - PK: `[UserID=userId, ObjectType="userSettings", ObjectID="_meta"]`
  - Fields: `defaults: {contexts[], areas[], energy[], timeRequired[], priority[], statuses[]}`, timestamps

Query patterns supported:

- All items across a user by status (ordered by dueDateUtc) — fan-out across that user’s list partitions
- All lists for a user — single user scope
- All items for a list — single logical partition (fast)

---

## Authentication and Authorization

- SWA routes enforce auth:
  - `/api/app` is allowed for anonymous and authenticated users (avoids 302 login loops with htmx on first load)
  - All other `/api/*` endpoints require authenticated
- Backend extracts `clientPrincipal.userId` from `x-ms-client-principal` and uses it as `userId` and `UserID` (PK)

staticwebapp.config.json routes:

```json
{
  "navigationFallback": { "rewrite": "index.html" },
  "routes": [
    { "route": "/api/app", "allowedRoles": ["anonymous", "authenticated"] },
    { "route": "/api/*", "allowedRoles": ["authenticated"] }
  ],
  "globalHeaders": {
    "content-security-policy": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "geolocation=(), camera=(), microphone=()"
  }
}
```

---

## Frontend Design

- Single-page shell (index.html) uses htmx to load `/api/app` on page load
- BeerCSS for components; minimal extra CSS to ensure responsive wrapping forms
- htmx swaps with server-rendered HTML partials; no client-side templating

Key UI choices:

- Quick Add Item form uses a responsive grid of BeerCSS fields to prevent overlapping controls
- Per-list defaults:
  - List selection updates only dependent dropdowns via htmx out-of-band (OOB) swaps
  - The form is not re-rendered to avoid focus shifts and calendar pop-ups
- Items panel:
  - Filter by status across all lists
  - List view shows Quick Add form scoped to the selected list
  - Toggle completion swaps only the affected list item row

UX gotchas fixed:

- Removed 302 login loop by allowing `/api/app` anonymous
- Prevented calendar auto-open and control overlap via OOB updates and responsive layout

---

## Backend Design

- Node.js v4 Functions, ESM modules, v4 programming model (`app.http(...)`)
- Entry point `api/index.mjs` imports all function modules (required for registration)
- `host.json` sets `routePrefix` to "" so SWA `/api/*` proxy aligns with function routes
- `api/shared/polyfill.mjs` binds Node’s Web Crypto to `globalThis.crypto.randomUUID` to satisfy dependencies expecting Web Crypto in the worker

Functions grouped by domain:

- App
  - GET `/app` — render main shell content (lists + default filtered items)
- Lists
  - GET `/lists/all` — list lists
  - POST `/lists/create` — create list, seed per-list defaults from user defaults
  - GET `/lists/editDefaults` — edit per-list defaults UI
  - POST `/lists/updateDefaults` — save per-list defaults
  - POST `/lists/resetDefaults` — copy user defaults into the list
  - GET `/lists/quickAddForm` — render Quick Add form for selected list defaults (used when opening a list)
  - GET `/lists/defaultOptions` — returns OOB fragments to update selects when list changes
- Items
  - GET `/items/byList` — list items in a list
  - POST `/items/create` — create item
  - POST `/items/toggleComplete` — toggle completed
  - GET `/items/filterByStatus` — filter items by status across lists with pagination
- Settings
  - GET `/settings/edit` — edit user-level defaults UI
  - POST `/settings/update` — save user defaults
  - POST `/settings/reset` — reset user defaults
  - GET `/settings/ensure` — seed defaults if missing
- Misc
  - GET `/health` — health check (anonymous)

Security helpers:

- CSRF: `api/shared/security.mjs`
  - Requires `HX-Request: true`
  - Validates `Origin` or `Referer` against `APP_ORIGIN` or the request’s own origin
  - Safe fallback for same-origin POSTs even if headers are missing (browsers can omit)
- Validation: `api/shared/validate.mjs`
  - `clip`, `cleanTag`, `toArrayClean`, `requireNonEmpty` used across inputs

Cosmos DB client: `api/shared/db.mjs`

Auth utility: `api/shared/auth.mjs` (extracts `clientPrincipal` and `userId`)

Polyfill: `api/shared/polyfill.mjs` (Web Crypto randomUUID)

---

## Security Posture

- SWA auth enforced by route rules; server double-checks user identity
- CSRF protection on POST endpoints
- Escaping:
  - All dynamic HTML outputs escape user-controlled text (`esc()`)
  - Fixed a specific toggle-complete response previously missing escaping
- Input validation:
  - Length caps and cleanup for text fields and tags
- HTTP security headers (CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
- Principle of least privilege (recommend managed identity + RBAC for Cosmos in production)

---

## Performance Considerations

- Partitioning:
  - Items for a list share a single partition ([userId, "item", listId]) for fast list queries
- Cross-list queries:
  - Filtering by status across all lists uses cross-partition fan-out within the user (expected use pattern)
- Pagination:
  - `/items/filterByStatus` supports continuation tokens ("Load more")
- Queries:
  - Use projection where possible (e.g., lists–title/ids only)
  - Consider composite indexes for common ORDER BY patterns (optional future IaC)
- Caching:
  - Optional: short-lived in-memory cache of user defaults (not included by default to keep simplicity)

---

## Deployment

- GitHub Actions workflow `Azure/static-web-apps-deploy@v1`
- SWA App serves static files; proxies `/api/*` to Functions
- Important deployment artifacts:
  - `api/host.json` (with `routePrefix: ""`)
  - `api/package.json` (`"type": "module"`, `"main": "index.mjs"`)
  - `api/index.mjs` (imports all function modules)
- Production environment variables (SWA Configuration):
  - `COSMOS_ENDPOINT`, `COSMOS_KEY`, `COSMOS_DB`, `COSMOS_CONTAINER`
  - `APP_ORIGIN` = `https://todo.jpto.dev`

---

## Local Development

Requirements:

- Node.js 20 (or 18)
- Azure Functions Core Tools v4
- SWA CLI
- Azurite (if using `UseDevelopmentStorage=true`)

Setup:

- `api/local.settings.json` (do not commit)

```json
{
  "IsEncrypted": false,
  "Values": {
    "AzureWebJobsStorage": "UseDevelopmentStorage=true",
    "FUNCTIONS_WORKER_RUNTIME": "node",
    "COSMOS_ENDPOINT": "https://<your-account>.documents.azure.com:443/",
    "COSMOS_KEY": "<your-cosmos-key>",
    "COSMOS_DB": "gtd",
    "COSMOS_CONTAINER": "gtd",
    "APP_ORIGIN": "http://localhost:4280"
  }
}
```

Run:

```bash
# install tools
npm i -g @azure/static-web-apps-cli azure-functions-core-tools@4 azurite

# install deps
(cd api && npm ci)

# start azurite in a separate terminal
npx azurite --silent

# start the app (from repo root)
swa start --api-location api --port 4280
```

Test:

- http://localhost:4280/ (app)
- http://localhost:4280/api/app (shell HTML)
- http://localhost:4280/api/health (OK)

---

## Configuration Summary

- Cosmos DB container:
  - SQL API
  - Partition Key: `/UserID`, `/ObjectType`, `/ObjectID`
- SWA config (routes + headers): `staticwebapp.config.json`
- Functions config: `api/host.json` (routePrefix empty)
- Package entry: `api/package.json` (`main: index.mjs`)
- Entry module: `api/index.mjs` (imports all functions)
- Polyfill: `api/shared/polyfill.mjs`

Production origin:

- `APP_ORIGIN = https://todo.jpto.dev`

---

## Key Design Decisions

Include:

- User-scoped data; stable userId from SWA `clientPrincipal.userId`
- Single Cosmos container with hierarchical PK matching existing schema: `/UserID`, `/ObjectType`, `/ObjectID`
- Co-locate items by list (`ObjectID=listId`) for efficient list queries
- HTML partials over JSON for htmx simplicity
- Per-user defaults and per-list overrides (copied from user defaults at list creation, with UI to edit/reset)
- Date-time UX: user inputs local timezone; store UTC (`dueDateUtc`)
- Security: CSRF check, escaping, input validation, secure headers

Exclude:

- Status as a partition key (explicitly avoided)
- Heavy frontend frameworks or bundlers
- Anonymous access to anything other than `/api/app` and `/api/health`

---

## Troubleshooting Notes

- 302 login loop: Allow anonymous access to `/api/app` (done) and remove 401 redirect overrides
- API 404 in Azure: Ensure `api/index.mjs` exists and is `main`, and `host.json` is at `api/` with `routePrefix: ""`
- crypto is not defined: Ensure `api/shared/polyfill.mjs` is imported first in `api/index.mjs`
- 403 on POST: CSRF check requires `HX-Request: true` and same-origin; set `APP_ORIGIN` and use updated CSRF logic that allows missing Origin/Referer for same-origin
- Overlapping controls / calendar popups: Fixed by responsive form layout and OOB select updates

---

## Future Enhancements (Optional)

- List rename/delete
- Settings CRUD for more fields (waitingOn people list, areas hierarchy)
- Composite indexes and IaC for Cosmos policies
- ETag-based concurrency on settings/updates
- Toast notifications and better loading indicators
- Search and bulk operations
- Managed Identity for Cosmos (replace key auth)

---

## Repository Layout

- `/index.html` — static shell (BeerCSS + htmx)
- `/staticwebapp.config.json` — SWA routes and security headers
- `/api/` — Functions app
  - `host.json` — Functions host config
  - `package.json` — ESM module config, `main: index.mjs`
  - `index.mjs` — imports all functions (entry)
  - `shared/` — `auth.mjs`, `db.mjs`, `defaults.mjs`, `templates.mjs`, `security.mjs`, `validate.mjs`, `polyfill.mjs`
  - `app/` — `index.mjs`
  - `lists/` — list CRUD + defaults (`all/create/editDefaults/updateDefaults/resetDefaults/quickAddForm/defaultOptions`)
  - `items/` — item CRUD (`byList/create/toggleComplete/filterByStatus`)
  - `settings/` — user defaults (`ensure/edit/update/reset`)
  - `misc/health.mjs` — health endpoint
- `.github/workflows/azure-static-web-apps.yml` — CI/CD to SWA

---