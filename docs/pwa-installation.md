# PWA installation and updates (issue #14)

The canonical native client at `/` now links the manifest and touch icon from
PR #28. The `/inbox.html` bookmark redirects to the same app. Installation
controls live in **Preferences → Install To-Do**, using the existing dialog,
disclosure, buttons and DESIGN.md styles. Capture and synchronization continue
using the existing account-bound IndexedDB/outbox.

## Install and reopen

- Chrome/Edge: **Install app** appears only when the browser supplies a
  `beforeinstallprompt` event. Only clicking it opens a prompt. Acceptance,
  `appinstalled` or standalone launch hides the installation controls.
- Dismissal suppresses the app's install button across reloads in that browser
  profile. Installation help and browser-menu installation remain available.
  If preference storage is blocked, dismissal lasts for the current page.
- iPhone/iPad help explains Safari → Share → Add to Home Screen, enabling
  **Open as Web App** if offered. Android and desktop get their own menu
  instructions. Unsupported browsers can keep using the web client.
- Sign in online once and wait for **Ready to reopen this inbox offline**.
  Installation alone does not initialize an account or back up pending work.
  A first-ever offline visit cannot download the app; help explains this before
  disconnection. A cached public shell without a verified device account asks
  the user to sign in online.
- Capture/edit, then reconnect and bring the app to the foreground or choose
  **Sync now**. There is no background-sync, extension or local-AI requirement.

An ordinary tab cannot reliably detect installations in another profile or an
external app. The client uses browser install events and standalone display state,
not a permanent installed flag that could outlive an uninstall.

## Identity, assets and hosting

`html/manifest.json` retains `id`, `start_url` and `scope` set to `/`,
To-Do naming, standalone display, and black theme/launch background. The 192/512px
PNGs include maskable artwork inside the central safe circle; the Apple touch icon
is 180px. `api/scripts/generate-pwa-icons.mjs` regenerates them.

SWA configuration excludes `/manifest.json` and `/icons/*` from HTML navigation
fallback and explicitly maps JSON/PNG MIME types. Assets are public; API routes
retain authentication and no-store protection. The existing same-origin CSP
allows the assets. The fixed launch/browser chrome color follows the manifest;
the existing app appearance preference controls content.

Before release, verify deployed HTTPS 200 responses with `application/json`
(or `application/manifest+json`) for the manifest and `image/png` for icons.
A missing icon must return a real failure, not index HTML. The local harness
checks bodies/types and Chromium manifest parsing; it does not emulate Azure
hosting or prove deployed headers.

## Safe shell updates

### Check or retry without closing your work

In **Preferences → App updates**, choose **Check for updates** while online.
The result appears in Preferences: checking, downloading, up to date, ready to
apply, or unable to finish. Offline checks explain how to retry after reconnecting;
browsers without service-worker support show a limitation instead of the button.
A failed initial registration can also be retried here without reloading.

The check does not reload the page or apply an update while app windows are open.
When an update is ready, wait for the draft's **saved on device** confirmation,
then close every app tab/window and reopen. The same instruction remains visible
outside Preferences. Repeated checks cannot force activation or clear drafts,
pending operations, or caches. If the check fails or exceeds 30 seconds, it
reenables retry; the browser may still finish a download and announce readiness.
Keyboard focus stays on the button during a check, and other controls remain usable.

The shell delivers these controls through fresh module URLs. Local Playwright
checks cover unchanged versions, offline checks, duplicate activation, request
failure, timeout/late completion, retry after failed initial registration, and
unsupported browsers. The real local service-worker test retries a failed asset
download through the button and verifies the waiting worker, saved draft and exact
outbox contents. Upgrade checks include prior shells. Physical-device and deployed update
verification remain release gates below.

The worker caches only the public root/index/bookmark shell, local scripts/styles,
manifest and icons. It never caches API/auth responses, task data or arbitrary
navigation URLs. Root/index navigation query parameters map to the public shell
offline without storing query-bearing copies.

The PWA script registers independently of account initialization, so a signed-out
visitor can prepare the public shell. Account verification still gates task data.
The shell/module URLs and worker handshake advance together. Fresh versioned
module URLs bypass old workers' exact allowlists during an upgrade.

Asset installation uses atomic `cache.addAll`. A failed download leaves the active
worker/cache usable. Successful updates wait until every app tab/window closes;
there is no forced activation or automatic reload. The update notice asks the
user to wait for their draft to save on device before closing. No IndexedDB reset,
outbox rewrite or old-cache deletion occurs. Pending operations synchronize
normally after reopening. A failed update reports online retry guidance.

Old caches are deliberately retained for compatibility. A future retirement policy
needs evidence that no client uses retired assets; do not clear site storage as an
update workaround. Unsynced data remains vulnerable to explicit storage clearing,
browser eviction and device loss; use device export.

## Automated evidence

The local HTTP harness uses disposable in-memory records. This is software
verification, not installed-device certification.

From `api/`, run `npm ci`, `npx playwright install chromium`, then `npm test`.

The multi-device check now waits for persisted changes and matching rendered items;
asynchronous persistence/worker checks use awaited polling. A deliberately delayed
change-response consumer and polling regression tests cover the failure.
Coverage includes:

- Parsed manifest, public asset paths/types, PNG decoding and maskable safe circle;
  anonymous access and SWA fallback exclusions.
- User-triggered install, dismissal/reload, accepted/installed states, prompt
  failure, blocked preferences and simulated iPhone/standalone behavior.
- Existing controls at 320/390/768/1440px in light/dark themes without horizontal
  overflow; keyboard focus returns to installation help or Close.
- Root/query/bookmark offline reopen, auth/API exclusion from Cache Storage and
  offline sign-in guidance for an uninitialized account.
- Failed asset download, atomic empty failed cache, preserved working shell,
  waiting-worker notice and unchanged draft/outbox.
- Upgrades from prior shells without mixed modules or changed queued intent; existing
  offline process restart, exactly-once reconnect, independent-client sync,
  conflicts, isolation, security and recovery checks.

Screenshots: [phone dark](design/pwa/install-dark-390.png),
[phone light](design/pwa/install-light-390.png),
[desktop dark](design/pwa/install-dark-1440.png),
[desktop light](design/pwa/install-light-1440.png).
These use an emulated iPhone user agent at the stated viewport widths to exercise
manual guidance; they are not Safari or physical-device evidence. Set
`PWA_SCREENSHOTS` to an output directory before running
`node --experimental-test-module-mocks --test test/pwa.test.mjs` to regenerate.

## Remaining release evidence

### Read-only deployed asset verification (October 3, 2026)

Run from `api/` with Node 22+ against an explicit HTTPS origin:

```sh
node scripts/verify-pwa-deployment.mjs https://todo.jpto.dev > pwa-deployment.json
```

The command makes eight anonymous GET requests: the root and bookmark shells,
manifest, three icons, service worker, and a unique nonexistent icon. It checks
HTTP status, MIME type, exact repository CSP and SHA-256 content agreement with
the checkout (text CRLF is normalized to LF; PNG bytes are unchanged). Redirects,
HTML navigation fallbacks, stale assets, missing/different CSP and 15-second
timeouts fail with exit code 1. JSON evidence includes the source commit, whether
`html/` is dirty, UTC timestamp and per-path results; it records no response bodies.
It never accesses API/auth endpoints, uses a signed-in browser or changes data.

The [recorded live report](pwa-deployment-2026-10-03.json) passed all eight checks
against `https://todo.jpto.dev` on Windows with Node 26.7.0. All seven public asset
bodies matched clean `html/` files at the report's `sourceCommit`; the random
missing icon returned 404. The deployed CSP matches the reviewed policy:
same-origin manifest/worker loading inherits `default-src 'self'`, and icons are
allowed by `img-src 'self' data:`. This checks delivered headers, not browser CSP
enforcement or installation. The checker deliberately fails on policy drift;
review a legitimate policy change before updating the checkout and rerunning.

`test/pwa-deployment.test.mjs` covers successful deployment evidence and injected
failure responses without network access. Existing `pwa-assets.test.mjs` checks
the matching manifest metadata and decoded icon dimensions/maskable artwork.
Run against the intended deployed revision: a newer local shell correctly fails
until that release is served. A matching subset of public files does not prove
the entire deployed Git revision, backend runtime or all shell modules.

Issue #14 stays open until the following are exercised, recording commit, date,
environment, OS/browser version, steps, expected/actual result and evidence:

| Check | Status |
| --- | --- |
| Deployed HTTPS manifest/icon paths, MIME types, missing-asset behavior and CSP headers | Pass, October 3, 2026; [live report](pwa-deployment-2026-10-03.json). Browser enforcement remains unverified. |
| Physical Android Chrome (including Pixel 4a), iPhone Safari and desktop Chrome/Edge install, name/icon and launcher reopen | Unverified |
| Standalone auth return, root/bookmark links, refresh, back and account switching | Unverified |
| Installed offline save/edit, process restart and one acknowledgement on a second physical device | Unverified |
| Real deployed shell update and interrupted download with drafts/outbox | Unverified |
| Real screen reader, 200% zoom and phone software keyboard in installed mode | Unverified |

No production flags, database documents, credentials or deployment settings were
changed during local verification. Use disposable accounts/data for deployed
checks. Source-level isolation does not certify real SWA ingress or Cosmos.

References: [MDN install prompts](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Trigger_install_prompt),
[MDN installability](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable),
[Apple iPhone web apps](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios).
