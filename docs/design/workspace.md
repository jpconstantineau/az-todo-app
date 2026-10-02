# Responsive workspace — issue 15, first pass

Reference: [HashiCorp design analysis](https://getdesign.md/hashicorp/design-md),
[component preview](https://getdesign.md/design-md/hashicorp/preview), and the
repository's [DESIGN.md](../../DESIGN.md). Baseline: `5dfa7a0`.

## Layout review and adopted proposal

The original HTMX screen puts a list-creation form before capture on phones,
expands every optional task field, and uses a fixed-width sidebar on desktop.
The durable inbox has its own dark stylesheet, a narrow single-column desktop
layout, and repeats long titles in action buttons. Neither offers a theme choice.

This pass uses one token system in `html/styles.css` for both clients. The
reference's black canvas, charcoal layers, white primary action, blue links,
restrained borders, 8px controls and 12px panels become app components. System
sans typography stays at 16px body, 14px supporting text, 22px section headings,
and 28px page titles. Spacing follows 4/8/12/16/24/32px. There are no added fonts,
dependencies, marketing layouts, logos, or product-color branding.

- HTMX: 248px list sidebar and flexible main column from 768px; one column below
  that. Native list navigation starts collapsed on phones and remains under user
  control. List creation and optional capture fields use native disclosures.
  Title, destination, and the save action remain visible.
- Inbox: capture and review share two columns from 1024px; smaller screens keep
  capture before review in document order. Edit and conflict recovery remain inline.
  Action labels are short, with full task titles preserved in accessible names.
- Shared states: readable metadata and empty/loading/error text, 44px controls,
  a 3px keyboard-focus outline, explicit disabled styling, and selected list
  borders with `aria-pressed`. Completion and sync states retain text labels.
  Settings, disclosures, and native dialogs inherit the same tokens; no new
  dialog or custom menu interaction is introduced.
- Appearance: System follows the OS, including live changes. Light/Dark is an
  explicit browser-local preference shared between clients and tabs. `theme.js`
  runs before CSS to avoid a saved-theme flash. Blocked storage still allows a
  choice for the current tab. Light mode is an app-specific adaptation required
  by issue 15, not a claim about the dark-only reference. CSS uses `light-dark()`
  and targets current browsers supporting that native feature.
- Accessibility takes precedence over reference colors: subdued copy uses the
  readable muted token instead of `#656a76`; dark errors use `#ff928b` and light
  links use `#005ec4`. Text state is never communicated by color alone.
- Offline shell cache moves to v2 and includes the shared CSS and theme script.
  As before, an existing worker waits for old tabs to close before activating.
  Task data and API/auth requests are not added to the shell cache.

## Evidence

Screenshots use disposable local test data, real application templates and
handlers, and mocked Cosmos storage. Chromium 153 on Windows; America/Regina;
900px viewport height. They are browser-content captures, not installed-PWA or
physical-device screenshots. Dark system preference is used for comparisons;
the baseline HTMX screen ignored it and stayed light.

| Width | HTMX before | HTMX after | Inbox before | Inbox after |
| --- | --- | --- | --- | --- |
| 320 | [Before](screenshots/before-workspace-320.png) | [After](screenshots/after-workspace-320.png) | [Before](screenshots/before-inbox-320.png) | [After](screenshots/after-inbox-320.png) |
| 390 | [Before](screenshots/before-workspace-390.png) | [After](screenshots/after-workspace-390.png) | [Before](screenshots/before-inbox-390.png) | [After](screenshots/after-inbox-390.png) |
| 768 | [Before](screenshots/before-workspace-768.png) | [After](screenshots/after-workspace-768.png) | [Before](screenshots/before-inbox-768.png) | [After](screenshots/after-inbox-768.png) |
| 1440 | [Before](screenshots/before-workspace-1440.png) | [After](screenshots/after-workspace-1440.png) | [Before](screenshots/before-inbox-1440.png) | [After](screenshots/after-inbox-1440.png) |

Additional evidence: [workspace keyboard focus](screenshots/after-workspace-keyboard-focus-320.png),
[inbox keyboard focus](screenshots/after-inbox-keyboard-focus-390.png),
[workspace light](screenshots/after-workspace-light-320.png),
[inbox light with long task text](screenshots/after-inbox-light-320.png).

![Desktop inbox after](screenshots/after-inbox-1440.png)

Run from `api/` with installed dependencies and Playwright Chromium:

```powershell
node --experimental-test-module-mocks --test test/*.test.mjs
$env:DESIGN_SCREENSHOTS='../docs/design/screenshots'
node --experimental-test-module-mocks --test test/design.test.mjs
```

All 32 checks passed. The design test checks four widths, initially collapsed
phone navigation, capture visibility, expanded forms/settings, 200-character
unbroken titles, keyboard focus, theme reload persistence, live system theme
changes, blocked localStorage, and themed offline reload. Existing tests cover
save failures, retained drafts, disabled saving controls, conflicts, account
isolation, and offline recovery.

Resolved text-token contrast against all three surfaces is at least **4.95:1
in light mode** and **4.59:1 in dark mode**. Primary action text also exceeds
4.5:1; focus and control-border tokens exceed 3:1 against those surfaces.
These are measured token pairs, not a claim of a complete accessibility audit.

Before screenshots were captured on the baseline with the same fixture using
`DESIGN_BASELINE=1`; preserve them when regenerating after screenshots.

## Questions and follow-up after merge

[Design questions are recorded in issue 15](https://github.com/jpconstantineau/az-todo-app/issues/15#issuecomment-5945505967):
navigation between clients, always-visible task metadata, inline versus drawer
editing/settings, browser-local versus account-synced appearance, and the target
installed PWA/device. Current defaults are complete and can merge before answers.

Issue 15 remains open. Actual installed-PWA screenshots and physical soft-keyboard,
safe-area, and non-Chromium verification remain outstanding. There is currently
no install manifest; adding an installation flow is not part of this styling pass.
Future clarification/review/brief screens should load the shared CSS rather than
copy tokens, but those screens are not invented here.

When answers arrive, fetch then-current `main` and start a fresh follow-up branch
and PR (or update a retained branch to that merged base before adding new work).
Reference issue 15 and this PR; do not depend on reopening the original PR or
reapply its commits after a squash merge. Re-run the relevant viewport/state
checks and append new evidence for the answered decisions.
