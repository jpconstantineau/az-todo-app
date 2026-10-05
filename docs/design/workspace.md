# Responsive workspace — issue 15

Reference: [HashiCorp design analysis](https://getdesign.md/hashicorp/design-md),
[component preview](https://getdesign.md/design-md/hashicorp/preview), and the
repository's [DESIGN.md](../../DESIGN.md).

## Current layout

The native client uses the shared token system in `html/styles.css`. The
reference's black canvas, charcoal layers, white primary action, blue links,
restrained borders, 8px controls and 12px panels become app components. System
sans typography stays at 16px body, 14px supporting text, 22px section headings,
and 28px page titles. Spacing follows 4/8/12/16/24/32px. There are no added fonts,
dependencies, marketing layouts, logos or product-color branding.

- Capture uses a large full-width input. Capture, Process, Execute and Lists
  share the same durable records, account/workspace drafts and recovery tools.
- Editing and preferences use native modal dialogs: a 560px side panel on desktop
  and a bottom sheet below 768px. Native modality isolates background controls.
  Escape and Close preserve an unsaved editor draft; a successful save clears it.
- Shared states use readable metadata and empty/loading/error text, 44px controls,
  a 3px keyboard-focus outline, explicit disabled styling and selected borders.
  Completion and sync states retain text labels.
- Dark is the default. Preferences offers Dark, Light and System; System follows
  live OS changes only when explicitly selected. `theme.js` runs before CSS to
  avoid a saved-theme flash. Blocked storage still allows a choice for the tab.
- Accessibility takes precedence over reference colors: subdued copy uses the
  readable muted token, dark errors use `#ff928b` and light links use `#005ec4`.
  Text state is never communicated by color alone.
- The offline shell caches only public client assets. Existing workers wait for
  old tabs to close before activating; task data and API/auth responses never
  enter Cache Storage.

## Current evidence

Screenshots use disposable local test data, production application templates and
handlers, and the in-memory Cosmos substitute. They are browser-content captures,
not installed-PWA or physical-device evidence.

| Width | Workspace | Capture |
| --- | --- | --- |
| 320 | [Workspace](screenshots/after-workspace-320.png) | [Capture](screenshots/after-inbox-320.png) |
| 390 | [Workspace](screenshots/after-workspace-390.png) | [Capture](screenshots/after-inbox-390.png) |
| 768 | [Workspace](screenshots/after-workspace-768.png) | [Capture](screenshots/after-inbox-768.png) |
| 1440 | [Workspace](screenshots/after-workspace-1440.png) | [Capture](screenshots/after-inbox-1440.png) |

Additional evidence: [workspace keyboard focus](screenshots/after-workspace-keyboard-focus-320.png),
[capture keyboard focus](screenshots/after-inbox-keyboard-focus-390.png),
[workspace light](screenshots/after-workspace-light-320.png),
[capture light](screenshots/after-inbox-light-320.png),
[393px capture](screenshots/after-inbox-393.png),
[1366px laptop](screenshots/after-inbox-1366.png),
[2560px desktop](screenshots/after-inbox-2560.png),
[phone lists](screenshots/after-lists-390.png),
[desktop lists](screenshots/after-lists-1440.png),
[desktop editor panel](screenshots/after-editor-panel-1440.png),
[phone editor sheet](screenshots/after-editor-sheet-320.png), and
[phone settings sheet](screenshots/after-settings-sheet-320.png).

![Desktop capture](screenshots/after-inbox-1440.png)

Run from `api/` with Node 22.x, installed dependencies and Playwright Chromium:

```powershell
npm test
$env:DESIGN_SCREENSHOTS='../docs/design/screenshots'
node --experimental-test-module-mocks --test test/design.test.mjs
```

The design test checks responsive widths, collapsed phone navigation, capture
visibility, expanded forms/settings, long unbroken titles, keyboard focus, theme
persistence, live System changes, blocked localStorage, offline reload, workspace
switching and modal focus/draft recovery. Existing tests cover save failures,
retained drafts, disabled saving controls, conflicts, account isolation and
offline recovery.

Resolved text-token contrast against all three surfaces is at least 4.5:1;
focus and control-border tokens meet 3:1 against their surfaces. These are
measured token pairs, not a claim of a complete accessibility audit. Installed
PWA, physical soft-keyboard, safe-area, screen-reader and non-Chromium checks
remain release evidence to collect on the intended devices.
