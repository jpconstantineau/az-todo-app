# Native client consolidation verification — issue #25

Run `npm test` from `api/` with Node 22.x and Playwright Chromium, or set
`PLAYWRIGHT_CHANNEL=msedge` for installed Edge. The browser suite runs production
HTTP handlers with real IndexedDB and service workers and an in-memory Cosmos
substitute. It does not exercise Azure authentication or a deployed Cosmos account.

## Local results

| Criterion | Result and evidence |
| --- | --- |
| Native feature parity | Pass: capture, empty lists/notes, task edits/moves, optional fields, custom status filter, completion/reopen, defaults save/reset/copy. See [parity matrix](../task-flow.md). |
| Durable intent | Pass: offline edits/reload, persistent browser close/reopen, lost acknowledgements, duplicate saves, bounded queues, failed transactions and recovery/export. |
| Upgrade preservation | Pass: release-baseline/next-module isolation, failed worker install, delayed activation with an open tab, retained drafts and unchanged queued operation IDs; old editor drafts retain typed edits and existing optional fields. |
| Multiple clients | Pass: separate browser contexts retrieve 52 records across change pages; concurrent defaults edits preserve both proposals and require explicit resolution. Existing competing-tab and task conflict checks pass. |
| Security/isolation | Pass in local harness: authenticated principal, exact origin, account ownership, no-store responses, malicious title rendering, logout/account-switch queue isolation and current-mutation route coverage. |
| Current data compatibility | Pass: stable IDs, complete field/original/link preservation, account export round trips, built-in/versioned defaults and historical custom-status reopening. |
| Shell and retirement | Pass: canonical root, explicit v1 gate states, retired-path not-found responses, offline reopen and cache inspection; runtime/dependency audit finds no HTMX. Only public shell assets are cached. |
| Layout/appearance | Pass in automated Edge viewports: 320/390/393/768/1366/1440/2560px, 200% reflow equivalent, reduced keyboard viewport, light/dark/system, dialog focus and keyboard saves. Minimum sampled text contrast: light 4.95:1, dark 4.59:1. |

The native parity test covers Regina local/UTC date conversion and clearing;
the defaults/DST test covers New York summer time and rejects nonexistent
spring-transition local times. Historical optional fields and defaults remain
editable without overwriting unrelated original text or links.

Runtime retirement audit: no HTMX imports, attributes, events, fragment headers or
CDN references remain in `html/`, `api/api/` or dependency manifests. Test references
to `HX-Request` deliberately verify that it grants no authority. Current operational
security evidence remains in the security and release documents. Retired pre-v1
route registrations and their recovery stubs have been removed.

## Review images

- Capture workspace: [390px](vanilla/after-inbox-390.png), [1440px](vanilla/after-inbox-1440.png).
- Optional task fields: [320px](vanilla/after-native-fields-320.png), [1440px](vanilla/after-native-fields-1440.png).
- User defaults dialog: [320px](vanilla/after-native-defaults-320.png), [1440px](vanilla/after-native-defaults-1440.png).

Images use disposable test data. The defaults dialog scrolls on short screens;
save and close controls remain reachable. Visual inspection covers both mobile
and desktop fields/defaults layouts; automated checks cover the broader matrix.

## Release gates still unverified

- CI status is reported by the PR, separately from these local results.
- Two real SWA identities and real Cosmos: trusted ingress, owner isolation,
  settings/task conflicts, receipt replay and staging rollback/reconciliation.
- Physical Android/Pixel 4a, iPhone and desktop browser offline/reopen flows,
  software keyboards, screen-reader operation and real OS storage eviction.
- Production promotion. No production flags or data were changed. Preserve all
  current v1 writes and each device's drafts/queue. Do not use a database or
  IndexedDB reset for deployment or rollback. See the
  [release/recovery procedure](../durable-inbox.md).

Keep #25 open for deployed verification. PWA installation/update UX remains #14;
navigation redesign remains #26, and identity/partition/sync documentation work
remains #27.
