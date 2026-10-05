# Paid-pilot release record (#17)

**Decision: NO-GO for paid-pilot certification.** This is the reproducible release
checklist for [roadmap #1](https://github.com/jpconstantineau/az-todo-app/issues/1).
Implementation and local tests do not establish deployed or physical-device
readiness. Keep #17 open until every required row has passing release evidence.

## Evidence rules

For each candidate, copy the matrix and scenario results into a dated release
record. Record the exact web/API commit, extension commit/build where applicable,
deployment workflow URL, environment/origin, date/time/timezone, tester, OS,
browser/device/assistive-technology versions, steps, expected and actual results,
and sanitized evidence links. Use separate rows for different environments.

Use **PASS**, **FAIL**, **UNVERIFIED**, or **BLOCKED**. PASS requires the recorded
observation on that candidate in the specified environment. Source/test-file
links below are starting points, not passing evidence. Preserve failed attempts
and link fixes/retests; changed runtime, API, shell or configuration invalidates
affected results. Never attach cookies, tokens, connection strings, raw auth
payloads or private task contents. Use disposable accounts A/B and synthetic data.

## Runtime and environment

The API build (`api/package.json` and lockfile), CI and managed SWA deployment
(`html/staticwebapp.config.json`, `platform.apiRuntime`) select **Node 22.x**.
This is a supported value in [Microsoft's SWA platform reference](https://learn.microsoft.com/en-us/azure/static-web-apps/configuration#platform),
checked October 2, 2026. Recheck support before a later release. CI tests that
major; a developer's newer local Node does not prove runtime compatibility.

The authenticated `GET /api/health` retains its `OK` body and reports the actual
`process.version` in `X-Node-Version`. It checks handler availability, not Cosmos
health. Record that response after each deployment and confirm `v22.*`; neither
a configuration file nor a successful static page proves which runtime started.
An anonymous request must be denied and must not receive that diagnostic header.

| Environment setting/check | Required value or observation | Release evidence |
| --- | --- | --- |
| Deployment | Exact commit and successful SWA workflow; `/html` app and `/api` API | UNVERIFIED |
| Node/Functions | Health header `v22.*`; verify managed Functions/resource configuration | UNVERIFIED |
| `V1_API_ENABLED` | Server-side `true`; session/operations usable | UNVERIFIED |
| `APP_ORIGIN` | Exact staging origin; production/preview verified independently | UNVERIFIED |
| `CosmosDbConnectionSetting` | Secret configured server-side; record presence only | UNVERIFIED |
| `COSMOS_DB` / `COSMOS_CONTAINER` | Explicit isolated target (defaults are `ToDoList` / `Items`) | UNVERIFIED |
| Cosmos topology | Hierarchical key `[/UserID, /ObjectType, /ObjectID]`, single write region, at least Session consistency; record index policy | UNVERIFIED |
| Ingress and cache | Managed backend or verified direct-URL restriction; authenticated API responses never shared/cached | UNVERIFIED |

Do not use a production database for staging. Do not empty an existing database,
clear IndexedDB, change partition keys, or remove receipts/history to get a green
result. Existing v1 data and device queues must survive rollout and rollback.

## Roadmap matrix

All local tests referenced here live in `api/test/`. The release column concerns
the deployed candidate, not the separate local regression run.

| Required outcome / issues | Local checks and procedure | Remaining release observation | Status |
| --- | --- | --- | --- |
| Fast browser/keyboard capture #5/#6 | `inbox.test.mjs`, [durable capture](durable-inbox.md) | Actually load TaskGem MV3; title/selection/source saved before popup closes; acknowledged import exactly once | BLOCKED: extension handoff absent from baseline |
| Persistent inbox/ordinary editing #2/#4/#5 | `inbox.test.mjs`, `browser.test.mjs`, `v1.test.mjs` | Phone offline process restart, edit/move/complete/reopen, reconnect without duplicates; quota recovery | UNVERIFIED |
| Actions, projects, optional areas #7 | `projects.test.mjs`, [project flow](projects.md) | One canonical action across inbox/project/day; ordinary list remains optional and usable | UNVERIFIED |
| Progressive clarification #9 | `clarification.test.mjs`, [procedure](clarification.md) | Accept/edit/skip/stop, reload midway, retain exact original and account-bound proposals | UNVERIFIED |
| Next/waiting/deferred #8 | `workflow.test.mjs`, `status-filters.test.mjs`, [date semantics](workflow-states.md) | Who/what awaited and review cue persist; timezone/date-only semantics and undo | UNVERIFIED |
| Daily/weekly review #10 | `reviews.test.mjs`, [review procedure](reviews.md) | Interrupt/resume; intentional keep/drop/defer; concurrent change blocks stale decisions | UNVERIFIED |
| Local AI and rules fallback #11 | `local-guidance.test.mjs`, [model procedure](local-guidance.md) | Real supported desktop download/inference/cancel/offline; unsupported phones retain manual flow | UNVERIFIED |
| Editable, accepted briefs #12 | `briefs.test.mjs`, [brief procedure](briefs.md) | Unknowns or explicit none-known; edit/reject/revise; only chosen revision accepted/exported | UNVERIFIED |
| Export/delete/recoverable edits #13 | `export.test.mjs`, `account-export.test.mjs`, `export-browser.test.mjs`, `delete-projection.test.mjs`, [export limits](device-export.md) | Complete account export, deletion/erasure and isolated recovery without stale resurrection | BLOCKED: account erasure/general recovery incomplete at baseline |
| Accessible interactions #16 | `accessibility.test.mjs`, [manual checks](accessibility.md) | Desktop screen reader plus TalkBack/VoiceOver; keyboard/zoom/phone keyboard; no focus loss or forced timer | UNVERIFIED |
| Phone/desktop PWA #14 | `pwa.test.mjs`, `pwa-assets.test.mjs`, [device checklist](pwa-installation.md) | Physical Android/iPhone/desktop install, auth return, offline reopen, interrupted update and retained queue | UNVERIFIED |
| HashiCorp styling #15/#26 | `design.test.mjs`, `navigation.test.mjs`, `mobile-workflow.test.mjs`, [design evidence](design/workspace.md) | Light/dark/system, 320/390/768/1440/2560px, 200% zoom, selected/focus/error states | UNVERIFIED |
| Security and account isolation #3 | `security.test.mjs`, [Azure checks](request-security.md#remaining-azure-verification-gate) | Real SWA accounts, forged ingress, exact origins, foreign references, success/error cache headers | UNVERIFIED |
| Repeat-safe protocol/backup #4/#27 | `v1.test.mjs`, `account-export.test.mjs`, `account-sync.test.mjs`, [protocol/recovery](data-api-v1.md) | Real Cosmos concurrency, lost acknowledgements, backup restore and rollback with post-backup writes | UNVERIFIED |

## Reproducible candidate run

1. Record the candidate SHA (`git rev-parse HEAD`) and clean status. From `api/`
   on Node 22.x, run `npm ci`, `npx playwright install chromium`, `npm test`.
   On Windows, installed Edge is an alternative with `PLAYWRIGHT_CHANNEL=msedge`.
   Retain the output and browser/Node versions. The harness runs real handlers
   and browser IndexedDB with an in-memory Cosmos substitute; it does not verify
   deployed authentication, RU costs or Azure transaction behavior.
2. Deploy the same candidate to the isolated SWA environment. Record the deployment
   URL/run and settings above. Inspect HTTPS `/`, `/manifest.json`, icons and a
   deliberately missing icon: correct bodies/MIME types, a real missing-asset
   failure, and CSP. The canonical client is `/`. Read the current shell baseline
   and asset URLs from `html/inbox-sw.js` and `html/pwa.js`.
3. Sign in normally as disposable A. Verify health/runtime, `/.auth/me` matching
   `/api/v1/session`, then capture a list with milk/bread/eggs, edit/move/complete/
   reopen, reload and confirm the same IDs and server-confirmed state. Do not
   inject a principal to simulate real authentication. Repeat as independent B.
4. Execute the adversarial scenarios below and the physical-device matrix. Record
   PASS/FAIL/UNVERIFIED independently. A mocked model or emulated phone cannot
   pass the real-model/physical-device gates.
5. Rehearse export, isolated restore and compatible rollback. Measure operations
   and verify monitoring/support readiness. Publish a dated go/no-go decision
   with all failures and missing evidence linked; no paid invitation before the
   required gates pass.

## Adversarial scenarios (all UNVERIFIED on deployed infrastructure)

| Scenario | Procedure and expected result |
| --- | --- |
| Concurrent first sign-ins/settings | Use two independent profiles of a fresh account. Open simultaneously; GETs must not create/reset settings. Save different defaults concurrently at expectedVersion 0: one commits, the other retains a resolvable conflict. Retry an acknowledged operation unchanged: no reset or second write. Repeat independent fresh accounts: no cross-account data. |
| Lost acknowledgement/double delivery | In the isolated environment, discard a response after the operation commits; resend the exact operation ID/content. One list/items batch and the original receipt remain. Changed content with the same operation ID returns `409 operation_reused`. |
| Same-record/two-device conflict | Start both profiles at version N. A saves N+1; B's offline edit must conflict and retain its proposal, block later queued writes, and require explicit resolution. Independent-record edits eventually both succeed. |
| Interrupted capture/clarification/review | Wait for device-saved acknowledgement, close/terminate, reopen offline. Exact original, drafts, decisions and pending operation IDs survive. Reconnect once; no duplication or silent acceptance. |
| Stale edit after deletion | Keep an edit pending on B, delete on A and sync B. Tombstone stays inactive, stale write cannot resurrect it, proposed text remains recoverable. Check every view and restore path. |
| Expired login/account switch | Expire A, then sign in as B with A's pending queue/draft. Writes pause, A's content disappears, and B never submits it. Sign back as A and recover. |
| Quota/write failure | Inject a storage failure in a disposable browser profile. No false saved acknowledgement; text and copy/export recovery remain available. Do not clear real pending storage. |
| Security failures | Follow #3's full matrix for missing/foreign/lookalike/conflicting origins, direct backend principal forgery, guessed IDs and foreign list/project/owner fields. Verify zero unauthorized writes and API/edge no-store behavior. |
| Paging/contention | Use enough synthetic history for multiple bounded pages; write during catch-up. No gaps; account_busy retries preserve intent. Verify Cosmos transaction rollback for an injected failing batch in staging. |

## Device evidence (all UNVERIFIED)

Use actual Android Chrome (including Pixel 4a), iPhone Safari and desktop
Chrome/Edge; record hardware/OS/browser versions separately. Check install/icon/
launcher, standalone sign-in return, offline capture/edit after force-close,
reconnect on a second device, interrupted asset download and a waiting shell
update while drafts/outbox exist. Close all tabs only after drafts save; reopening
must not reset storage. Check desktop keyboard/screen reader, Android TalkBack or
iPhone VoiceOver, 200% zoom, light/dark appearance and an open phone keyboard.
Record unpacked TaskGem installation/handoff and real local-model evidence as
separate rows; phone operation must not depend on either feature.

## Recovery, costs and operations (all UNVERIFIED)

- Export device-only drafts/outbox as well as server data. Validate exports with
  the existing [round-trip tool](device-export.md). A device snapshot is not proof
  of complete account coverage, server backup or automated restore capability.
- Rehearse [backup/restore/rollback](data-api-v1.md) in an isolated target. Compare
  owners, IDs, original text, links, versions, tombstones, receipts/history and
  cursors. Include writes after the backup and stale device queues. Restore must
  not resurrect erased accounts or reset current v1 data.
- Record a known compatible API/client SHA and deployment settings before rollout.
  For rollback, preserve all newer records and queues, verify compatibility in
  staging, then redeploy that pair. Disabling v1 pauses sync. Never treat a
  browser-storage clear or stale backup as rollback.
- Measure representative small/large accounts, cold/warm capture and reads,
  catch-up pagination and competing-device writes. Record sample counts, p50/p95
  latency, RU/request, retries/429/503, bytes/pages and history/storage growth.
  Agree numeric pilot budgets before scoring; no measured budget exists here.
  `partition-profile.test.mjs` measures application JSON in memory, not billed RU.
- Verify Azure monitoring/alerts for request failures, latency, Cosmos throttling
  and storage growth with a synthetic staging failure. Capture route/status,
  duration, retry count and sanitized correlation IDs; exclude bodies, task text,
  cookies/tokens and raw account identifiers. Record the alert owner, threshold,
  destination and observed delivery. This PR does not configure Azure monitoring.
- Before invitations, publish the support contact/escalation path, cancellation
  and data-deletion procedure, retention/backup limits and recovery expectations.
  Pending offline work can be lost to storage clearing/eviction/device loss;
  foreground sync needs a valid session. Local inference is optional and distinct
  from cloud task storage. No automatic cloud AI or background-sync guarantee.

## Current evidence and decision

Baseline inspected: `eb41954258c6dd36aff80f39b77fe8666d355a50` (main, including
server account export from PR #53). Local runtime verification is reported in the
PR with the exact tested commit, command, versions and result; no deployed
runtime observation is claimed by this document.

**NO-GO** remains until the blocked features and unverified release observations
above are resolved. This focused #17 change aligns the runtime and makes the
remaining evidence auditable; it does not certify a paid pilot. Record the final
release owner, date and evidence links when the decision changes. Keep payment,
cancellation and repeat-use cohort results in a separate commercial record.
Recurrence, reminders, calendar/time blocking, billing automation and broad
integrations remain outside the companion pilot claim.
