# PWA installation assets (issue #14)

This is the independently mergeable asset preparation explicitly allowed by
[#25](https://github.com/jpconstantineau/az-todo-app/issues/25). It does **not**
enable installation or certify the app as an installed PWA. Existing HTML,
routing, rollout flags, service worker, API and device data are unchanged.
Issue #14 stays open.

## Assets and identity

- `html/manifest.json`: To-Do, standalone display, stable `id: "/"`,
  `start_url: "/"` and `scope: "/"`. The start URL targets #25's planned
  canonical root entry; do not promote it while root still serves the legacy UI.
  Keep the ID stable through future entry-point changes to avoid a new identity.
- `html/icons/icon-192.png` and `icon-512.png`: actual square PNGs.
  The 512px asset supports both ordinary and maskable use, with opaque black
  bleed and all foreground artwork inside the central 80%-diameter safe circle.
- `html/icons/apple-touch-icon.png`: opaque 180px Apple touch asset.
- `html/icons/icon.svg`: editable vector source. The black canvas, charcoal
  surface, white border and blue check reuse DESIGN.md and existing app colors.
  No fonts, external imagery or runtime image dependencies are needed.

Regenerate from `api/` after installing the existing dependencies and browser:

```sh
npm ci
npx playwright install chromium
node scripts/generate-pwa-icons.mjs
node --test test/pwa-assets.test.mjs
```

Installed Edge can be used with `PLAYWRIGHT_CHANNEL=msedge`. PNGs are checked
in, so deploying the app does not require running the generator.

## Integration after the consolidated shell is ready

Add these tags to the canonical shell's head (and any separately served inbox
shell that #25 retains):

```html
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
<meta name="theme-color" content="#000000">
```

The fixed launch background matches the app's default dark appearance.
Appearance-aware browser chrome can follow the existing theme preference at
integration time. Keep both entry points on the same manifest and ID.

Serve the manifest anonymously as `application/json` (or
`application/manifest+json`) and icons as `image/png`. Verify real HTTP headers
and 200 bodies on Azure: a navigation fallback returning HTML is not a valid
asset response. No SWA MIME/configuration change is made in this preparation PR;
JSON uses the existing static-file path. Check that the deployed CSP permits
same-origin manifests and images.

Integrate the public assets into #25's versioned shell allowlist only with its
safe update flow. Do not cache API/auth responses or task data, force worker
activation, delete old caches still used by clients, or reset IndexedDB. Manifest
metadata alone neither provides offline capture nor fixes an offline root route.

Once that shell is verified, implement #14's install experience: expose a
user-triggered install button only when the browser offers installation; hide it
after installation and avoid repeat prompts after dismissal. Otherwise offer
manual platform guidance, including iPhone Add to Home Screen. No extension or
AI capability should gate installation.

## Verification and remaining release gates

The focused Node/Playwright check validates manifest metadata, referenced files,
PNG signatures and decoded dimensions, opacity, nonempty artwork and the
maskable safe circle. It runs automatically with the existing `npm test` glob.
These are repository asset checks, not deployed installability checks.

Record exact commit, environment, date, OS/browser version, steps,
expected/actual results and evidence for each remaining check below. Keep a row
unverified until exercised; screenshot emulation cannot certify physical devices.

| Check | Status in this asset preparation |
| --- | --- |
| Deployed HTTPS manifest/icon paths, headers and browser manifest parsing | Unverified; link after #25 integration |
| Android Chrome (including Pixel 4a), iPhone Safari, desktop Chrome/Edge install and launcher icon | Unverified |
| Standalone root/inbox launch, auth return, reload, deep links and back navigation | Unverified |
| Supported install button, dismissal, already installed and iPhone manual guidance | Pending integration |
| Offline save/edit, process termination/reopen, reconnect and one acknowledged result on another device | Unverified |
| Update with a draft/outbox, interrupted asset download and old-worker compatibility | Unverified |
| Account expiry/switch/logout and absence of API/auth data in shell caches | Unverified for installed app |
| First-ever offline limitation and foreground retry without background sync | Unverified for installed app |

Use disposable accounts/data for the two-device and account-isolation checks.
The existing durable inbox is the persistence path; reuse it during integration.
Full installation/update UX and device evidence remain #14/#17.

References:
[MDN installability](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable),
[MDN app icons](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Define_app_icons),
[manifest identity](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/id).
