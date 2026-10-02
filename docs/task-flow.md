# Basic task flow and verification

Issue: [#2](https://github.com/jpconstantineau/az-todo-app/issues/2).

`html/index.html` is the only document shell. It loads `/api/app` into `#app`.
The API returns fragments, never a second document. Anonymous visitors receive
the SWA GitHub sign-in link; the signed-in workspace offers SWA sign-out and settings.
All templates use the same `esc` helper for text and attributes.

## Fragment contracts

| Method and route | Inputs | Response / target |
| --- | --- | --- |
| GET `/api/app` | SWA principal | Workspace inside `#app`, or sign-in prompt |
| GET `/api/lists/all` | — | List buttons inside `#listsContainer` |
| POST `/api/lists/create` | `title`, `description` | List buttons; OOB destination, defaults and selected list view |
| GET `/api/items/byList` | `listId` | Heading, description and item rows inside `#itemsView`; OOB destination and defaults |
| POST `/api/items/create` | `listId`, `title`, `description`, `status`, `dueDateUtc`, `context`, `area`, `energy`, `timeRequired`, `priority` | Updated selected list view inside `#itemsView` |
| POST `/api/items/toggleComplete` | `id`, `listId` | One `article`, replacing the closest item article |
| GET `/api/items/filterByStatus` | `status`, optional `ct` | First page inside `#itemsView`; later pages replace their own load-more wrapper |
| GET `/api/lists/quickAddForm` | `listId` | Form inside `#quickAddContainer` (available, not used during selection) |
| GET `/api/lists/defaultOptions` | `listId` | OOB select replacements, no ordinary swap |
| GET `/api/settings/edit` | — | User defaults inside `#settingsPanel` |
| POST `/api/settings/update` | `contexts[]`, `areas[]`, `energy[]`, `timeRequired[]`, `priority[]`, `statuses[]` | User defaults inside `#settingsPanel`; filter options updated OOB |
| POST `/api/settings/reset` | — | Same shape as settings update |
| GET `/api/lists/editDefaults` | `listId` | List defaults inside `#settingsPanel` |
| POST `/api/lists/updateDefaults` | `listId` plus the six defaults fields | List defaults inside `#settingsPanel` |
| POST `/api/lists/resetDefaults` | `listId` | List defaults copied from user defaults inside `#settingsPanel` |

The registered `/api/settings/ensure` and `/api/health` endpoints have no UI controls.
General item/list editing and deletion are not presented as available actions.
Defaults are edited one option per line; repeated array inputs remain supported.
Saving defaults refreshes the selected list's options without replacing the capture form.

The browser converts `dueLocal` from its own timezone to `dueDateUtc` before submission.
The server stores UTC and the browser displays it in local time. A local-only date
without its UTC conversion is rejected, rather than interpreted in the server's timezone.
Completion records the prior status; reopening restores it (legacy completed records
without that field reopen as `next`). This remains a toggle, not a repeat-safe write.

List selection does not replace the capture form. Validation, HTTP, network and
session-expiry failures retain entered values and display an error using `textContent`.
Submit buttons are disabled during requests. Successful creates clear only submitted
text that has not changed while the request was in flight. A failed or lost response
may follow a committed write; the UI asks users to inspect the list before retrying.
Durable offline drafts, operation receipts and conflict recovery belong to #4/#5.

## Run the tests

Use Node 24 for the test runner (module mocking requires a recent Node version).

```sh
cd api
npm ci
npx playwright install chromium
npm test
# HTTP/template checks only:
npm run test:contracts
```

On a machine with Edge installed, set `PLAYWRIGHT_CHANNEL=msedge` to avoid installing
Chromium. Set `TEST_SCREENSHOT` to an absolute PNG path for an optional browser capture.
CI installs Chromium and runs the complete suite on Node 24.

The harness imports the production entry point and captures its registered handlers.
Requests cross a real loopback HTTP server using Azure `HttpRequest`/`HttpResponse`
types. Only Cosmos storage and function registration are substituted. Storage is
disposable, in memory, and implements the query/projection/partition behavior used by
these handlers; it does not certify Cosmos queries, indexing, or durability. The
browser uses the exact HTMX 1.9.12 package corresponding to the deployed CDN script.

## Evidence and limits — October 1, 2026

Passed locally on Windows with Node 24.19.0 and Edge 154.0.4258.48:

- Signed-in create-list → select-list → add-item → reload/reselect → complete/reopen.
- Titles, descriptions, destination, UTC due time and context/area/energy/time/priority round trips.
- Empty, populated and adversarial templates; all advertised API methods/routes registered;
  one document, no duplicate IDs, and no executable user markup.
- User and list defaults save/reset; status filtering and continuation-page contract.
- Validation, injected storage failure, network failure and 401 retain form text.
  Text typed during a pending successful save also survives.
- Desktop and 390 × 844 viewport; America/Regina timezone conversion; no page JavaScript errors.

This is local handler/browser verification, not Azure deployment or physical-phone
verification. No production records were created. SWA authentication, direct Functions
ingress, real Cosmos persistence/indexes, and deployed runtime must still be verified
in a disposable Azure environment under #3/#17. The existing CSRF bypass is outside
this repair and remains tracked in #3. The current runtime configuration is
`api/host.json` (`api` route prefix), entry `api/api/index.mjs`, and
`CosmosDbConnectionSetting` for the Cosmos connection; older examples in
`description.md` are not deployment evidence.
