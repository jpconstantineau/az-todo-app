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

Shell v12 caches only the public root/index/bookmark shell, local scripts/styles,
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

Verified October 2, 2026 on Windows `10.0.26200`, Node `v26.7.0`, Playwright
Chromium `153.0.8010.12`, against the local HTTP harness with disposable in-memory
records. Revision: the implementation commit introducing this document's install
flow, based on main `84f49c6`; the PR records the exact tested commit.
PR #31 merged during implementation; its project/day views are retained, and the
PWA shell advances from its v6 to v7 to avoid reusing cached module URLs.
The workflow integration in PR #33 advances the combined shell to v8 and retains
the installation flow and upgrade coverage through v7.
This is software verification, not installed-device certification.

From `api/`, run `npm ci`, `npx playwright install chromium`, then `npm test`.

Result: **60/60 passing** after correcting the CI test synchronization race.
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
- Upgrades from v3/v4/v5/v6 without mixed modules or changed queued intent; existing
  offline process restart, exactly-once reconnect, independent-client sync,
  conflicts, isolation, security and migration checks.

Screenshots: [phone dark](design/pwa/install-dark-390.png),
[phone light](design/pwa/install-light-390.png),
[desktop dark](design/pwa/install-dark-1440.png),
[desktop light](design/pwa/install-light-1440.png).
These use an emulated iPhone user agent at the stated viewport widths to exercise
manual guidance; they are not Safari or physical-device evidence. Set
`PWA_SCREENSHOTS` to an output directory before running
`node --experimental-test-module-mocks --test test/pwa.test.mjs` to regenerate.

## Remaining release evidence

Issue #14 stays open until the following are exercised, recording commit, date,
environment, OS/browser version, steps, expected/actual result and evidence:

| Check | Status |
| --- | --- |
| Deployed HTTPS manifest/icon paths, MIME types, missing-asset behavior and CSP | Unverified |
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
