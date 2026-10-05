# Deployed SWA security rehearsal (#3)

`npm run test:security:deployed` is an opt-in HTTP check against a **disposable
SWA environment and two distinct disposable accounts**. It uses real signed-in
session cookies and the environment's existing Cosmos connection. It creates
synthetic list, project and item records through the normal v1 API, probes account
isolation and origin protection, then deletes only its generated record IDs.
Normal `npm test` never connects to Azure or reads these cookies.

This runner does not close #3 or certify #17. No deployed run is claimed by this
change. Local regression tests run the same probes through production handlers,
with simulated SWA ingress and in-memory storage. Real Azure resource topology,
deployment identity and browser behavior remain separate observations.

## Before running

1. Deploy the candidate to isolated SWA/Cosmos infrastructure. Record the successful
   deployment URL/run and exact deployed SHA. Enable `V1_API_ENABLED` and configure
   the exact environment origin in `APP_ORIGIN`. Do not point this tool at an
   ordinary account or a production environment.
2. Inspect Azure resource configuration: confirm managed Functions have no separate
   public backend. If using linked Functions, independently verify the ingress
   restriction and supply its direct HTTPS origin for the optional anonymous probes.
   An inaccessible URL or a 404 is not treated as passing authentication evidence.
3. Sign in normally as A and B using separate browser profiles. Copy each disposable
   session's Cookie request-header value from a same-origin API request using the
   browser's developer tools. Keep these values local; never attach them, exported
   HAR files, raw principal payloads or private task text to issues/PRs. The runner
   does not log them, follow redirects, or send them to a direct backend.
4. Stop other clients for these accounts. The origin tests compare account history
   before/after and will fail if another client writes during that phase. Paging is
   bounded at 100 pages per account/route, so use fresh disposable accounts.

From `api/` on Node 22, with installed dependencies, set process-only environment
variables. For example, in PowerShell 7 (masked prompts avoid shell-history secrets):

```powershell
$env:SECURITY_ORIGIN = 'https://your-isolated-swa.example'
$env:SECURITY_DEPLOYED_COMMIT = '<full 40-character deployed commit SHA>'
$env:SECURITY_COOKIE_A = Read-Host 'Disposable account A Cookie header' -MaskInput
$env:SECURITY_COOKIE_B = Read-Host 'Disposable account B Cookie header' -MaskInput
# Optional, only for a linked/external backend:
# $env:SECURITY_BACKEND_ORIGIN = 'https://your-isolated-backend.example'
try {
  npm run test:security:deployed -- --disposable-environment "$env:TEMP/security-evidence.jsonl"
} finally {
  Remove-Item Env:SECURITY_COOKIE_A, Env:SECURITY_COOKIE_B -ErrorAction SilentlyContinue
}
```

Choose a new report path for every run; existing evidence is never overwritten.
Only exact HTTPS origins are accepted, without credentials, paths or trailing
slashes. The explicit flag acknowledges synthetic writes, tombstone/history
retention and resource usage. Cookies never appear in command arguments.
Expired/rejected sessions, identical accounts, login redirects, request failures,
wrong response shapes and missing protections fail the run. Each HTTP request has
a 15-second timeout and a 2 MiB response-body bound. There are no automatic retries
that could obscure a failed security observation.

## Checks and evidence

The JSONL report appends durable snapshots. Read its **last complete line** after
interruption. It records the operator-declared deployed SHA, origin, Node version,
UTC timestamps, named check results, route names, HTTP statuses and boolean header
checks. Account labels are A/B; raw account IDs, cookies, response bodies, task text,
redirect destinations and exception messages/stacks are omitted. Header checks
report cache-control no-store without public/shared-cache directives; handler
responses additionally require private, nosniff, no-referrer, DENY and the four
API CSP directives. Edge-generated denials require no-store; handler-only headers
are recorded separately rather than assumed to exist at the edge.

| Probe | Required result |
| --- | --- |
| Anonymous and forged principal at SWA | 401/403; no-store |
| Optional direct backend | Same denial, without either session cookie; manual topology verification still required |
| Real A/B sessions; A supplies B's principal and vice versa | Distinct account identities; client-supplied principal cannot change either identity |
| Exact Origin, matching Referer, Referer-only | Synthetic writes commit in each account |
| Every current mutation route | Missing/empty/null/malformed/foreign/lookalike/wrong scheme/wrong port/path Origin, conflicting/malformed Referer, cross-site/same-site and HX/forwarded-header bypass attempts fail with 403 |
| Rejected origin writes | No new v1 account sequence, fixture record or operation receipt; every current mutation route returns 403 |
| Foreign account parameters | Records, receipts, changes, exports and update/delete operations reject account mismatch |
| Guessed IDs under the attacker's own account | Foreign list/project/item/receipt absent; update/delete produces a conflict with no foreign current record |
| Foreign list/project references, owner fields and invalid input | Moves, forged fields, oversized title and unconfigured status fail; both original items remain unchanged |
| Changes and export pages | More than one page; account ID checks on envelopes/records/conflict snapshots; own fixtures present and the other account's fixtures absent |

The tests use generated IDs; they do not enumerate other users or guess real data.
The report's generated fixture IDs are saved **before** any possible create, so a
lost response still leaves a recovery record. Reports may be several MiB because
each checkpoint retains a complete snapshot. Keep them outside the repository.

## Cleanup and failures

Cleanup runs after success or failure. It reads only the generated IDs, verifies
their account/type/identity, tombstones items first and then empty lists/projects,
and verifies the resulting tombstones. It also checks IDs from uncertain creates.
It never resets settings, clears a database, purges history or touches arbitrary
pre-existing IDs. Tombstones, receipts, conflict proposals and change history remain
indefinitely under the application's existing retention policy. This is **not
account erasure**. Dispose of the isolated test environment through your normal
approved process when finished.

A failed cleanup makes the run FAIL and retains the exact generated IDs and A/B
labels for manual recovery. A process kill or report-disk failure can interrupt
cleanup; consult the last complete line, sign back in as the appropriate test
account and inspect those IDs before removing remaining synthetic records. Do not
blindly rerun or treat another run as cleaning up the previous run's fixtures.

PASS means these HTTP probes and cleanup passed, not that every #3 requirement is
proven. Match the declared SHA to deployment evidence; independently inspect Azure
topology, exercise an actual browser mutation/authentication flow, and inspect
shared-cache behavior across real clients. No browser CORS policy, physical-device,
screen-reader, backup/restore or capacity claim follows from this runner. Preserve
failed reports and link the fix/retest evidence when updating the release record.
