# Request protection and account isolation

Implementation and evidence for [issue #3](https://github.com/jpconstantineau/az-todo-app/issues/3).
The source changes and local tests are complete; the Azure verification gates below
must pass before closing the issue or claiming pilot readiness.

## Trusted authentication boundary

The deployment workflow packages `html/` and `api/` together using Static Web Apps
(SWA) managed Functions. The intended path is browser → SWA authentication and
route authorization → managed Functions → owner-scoped Cosmos queries.
`html/staticwebapp.config.json` requires the `authenticated` role for every API route.

Microsoft documents that [managed Functions are not available outside SWA](https://learn.microsoft.com/en-us/azure/static-web-apps/apis-functions),
and that [SWA supplies user information to the API through `x-ms-client-principal`](https://learn.microsoft.com/en-us/azure/static-web-apps/user-information).
The API checks the principal's shape, bounded user ID, and authenticated role.
Decoding Base64 is **not authentication**: a syntactically valid principal is trusted
only because requests must cross that ingress. `HX-Request`, Origin, Referer,
forwarded headers, and submitted owner fields never establish identity.

Do not expose this code as an anonymous standalone Functions endpoint. If the
deployment is changed to a linked Functions app, independently restrict/authenticate
that backend at the platform boundary before accepting principal headers. Source
inspection and the local test harness cannot prove the deployed resource topology.
The test harness injects principals deliberately; it is not an authentication proxy.

## Browser-session CSRF policy

Every route registers through `shared/http.mjs`. All methods other than GET, HEAD,
and OPTIONS require authentication and `checkCsrf` before the handler can write.
The native static shell contains the sign-in link. Private data writes, including
user/list defaults, use `/api/v1/operations`; shared shopping/family lists use
`/api/shared/operations` with the same guard and additional list permissions.

Set the **server-side** SWA application setting `APP_ORIGIN` to the exact public
origins permitted in that environment, for example `https://todo.jpto.dev`.
Preview environments need their own exact preview origin. Multiple origins are
comma-separated, with no paths, trailing slashes, credentials or wildcards.
An empty setting or any malformed entry rejects all mutations. When the setting
is absent, only the parsed request URL's origin is allowed; this supports local
development and proxies that preserve the public URL. If the proxy supplies an
internal backend URL, explicitly configure the public origin. Forwarded headers
are never used to expand the allowlist.

| Browser headers | Result |
| --- | --- |
| Exact allowed Origin; Referer absent or same origin | Accept |
| Origin absent; valid Referer from an allowed origin | Accept |
| Both absent, empty, malformed, or Origin `null` | Reject with 403 |
| Foreign origin, prefix lookalike, wrong scheme or port | Reject with 403 |
| Origin and Referer disagree, even if both origins are allowed | Reject with 403 |
| `Sec-Fetch-Site` supplied with any value except `same-origin` | Reject with 403 |
| `HX-Request: true` alone | Reject with 403 |

This intentionally requires browser origin evidence. Non-browser callers must not
use principal spoofing or relax the policy for compatibility. A future extension
handoff uses the separately authenticated boundary specified in #6. No CORS
allowance or extension authentication mechanism is introduced here.

## Ownership, inputs, and responses

Every private v1 query binds the authenticated `UserID`; point replacements include the full
`[accountId, "sync", "v1"]` partition key. Destination lists and item/list pairs are looked up
within that owner. Foreign and nonexistent references return the same 404.
Submitted `userId`, `UserID`, `ObjectID`, and `ObjectType` cannot choose an account
or partition. List and item creation construct these values on the server.

[Shared lists](shared-lists.md) use a separate list partition. Only the creator or
an explicitly invited member can read a list. All mutations check current grants
in the same ETag-controlled transaction as the change and its receipt. Revocation
blocks later reads/writes, including stale offline actions. Shared records cannot
link or grant access to private workspaces/projects. Directory pages bind the
verified account; invitation codes are single-use, expire, and are hashed at rest
on the server. Revocation cannot erase already-downloaded device copies.

Titles are limited to 200 characters, descriptions to 4000, record/operation IDs to 128, and option
values (including configurable statuses) to 64. Defaults accept at most 200
nonempty entries per field, then deduplicate. Oversized values, unsupported control characters, malformed JSON and impossible
UTC dates are rejected instead of clipped. Unknown owner fields cannot select an
account. Item status is validated against core states and effective list/user
options; existing and prior-completion states remain usable. Historic statuses
remain readable, and reopening restores an item's prior status.

All handler responses, including sign-in, authorization failures, validation
failures, and caught storage errors, include:

```text
Cache-Control: private, no-store
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
X-Frame-Options: DENY
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

The API CSP prevents API responses from acting as executable documents. The shell
uses local modules/styles and no longer allows CDN scripts or unsafe inline code. Headers are set by the API because
[SWA global headers do not apply to API responses](https://learn.microsoft.com/en-us/azure/static-web-apps/configuration#global-headers).
Responses generated by the platform before the handler runs require separate
deployed verification. The native client preserves local drafts/queued intent on validation, authentication
and storage failures. Retry receipts handle lost acknowledgements; v1.test.mjs
exercises repeat-safe recovery.

## Historical baseline evidence — October 1, 2026 (before #25)

Run `npm test` in `api/` with Node 24 and installed Playwright Chromium, or set
`PLAYWRIGHT_CHANNEL=msedge` when Edge is installed. `test/security.test.mjs` runs
through the real registered handlers and Azure HTTP types over loopback HTTP.
Only storage and function registration are substituted.

Local Windows verification passed on Node 26.7.0 and Edge 154.0.4258.48:

- Both current mutation routes reject missing, foreign,
  malformed and conflicting origin evidence without modifying any documents;
  legitimate requests work without `HX-Request`.
- Every registered route rejects invalid/unauthenticated principals and returns
  the API security/cache headers.
- Two disposable accounts cannot see each other's list/item/settings data or
  mutate foreign records by guessing IDs, changing references, or forging owners.
- All current GET handlers are read-only, including first-time page loading.
- Oversized fields/defaults, invalid statuses, malformed forms, uploaded files and
  invalid dates fail before writes; a 64-character configured status is preserved.
- Real HTMX capture, selection, defaults and completion flows still work. A real
  API 403 is delivered to the browser and leaves the draft intact. Desktop and
  390px layout checks pass in America/Regina.

The tests enumerate the registered routes, require explicit positive/isolation
fixtures for new routes, and fail if a production module imports Azure's HTTP
registration directly instead of the shared guard. Move/export/delete/project
operations do not exist yet; their isolation must be added when those routes are
introduced. In-memory tests do not certify real Cosmos queries or partitioning.

Two read-only requests against the existing `https://todo.jpto.dev/api/lists/all`
deployment returned **401** and `Cache-Control: no-store`: one without credentials,
one with a forged disposable principal plus `HX-Request: true`. This shows the
public edge rejected those anonymous attempts on that deployment; it does not
verify this branch, authenticated headers, or direct backend ingress.

## Remaining Azure verification gate

The [opt-in deployed security runner](security-rehearsal.md) now exercises the
current private/shared mutation boundaries and two-account isolation over HTTPS.
It writes only generated synthetic records, records sanitized response checks and
tombstones its fixtures. Its local regression tests use the production handlers
with a simulated ingress and in-memory Cosmos; they do not pass this Azure gate.
Use the runner's report alongside the manual observations below. The historical
pre-v1 section above is not the current route or capability inventory.

Use a disposable Azure environment and two real SWA accounts. Record the deployed
commit, resource/environment identity, timestamp, and response statuses/headers
without saving session cookies or task contents:

1. Confirm in Azure that this environment uses **managed** Functions, with no
   separately reachable backend. For any linked/external backend, test its actual
   direct URL anonymously and with a forged principal: both must be denied before
   a handler can read records. Do not infer the resource configuration from YAML.
2. Configure `APP_ORIGIN` for that environment and check a real browser mutation
   succeeds. Exercise missing, foreign, lookalike and conflicting origins against
   each mutation route with a disposable authenticated session. Verify no writes.
3. Repeat the account-isolation cases using real Cosmos records and both accounts,
   including status-filter continuation pages and guessed item/list combinations.
4. Inspect actual success and error response headers from the authenticated API,
   as well as 401/403 responses generated at the SWA edge. Verify no shared cache
   serves one account's response to the other.

Azure resource inspection, direct-backend checks, authenticated deployed tests,
and real Cosmos verification were not available in this checkout/session. Keep
#3 open until that evidence is recorded; #17 retains the broader release gate.
