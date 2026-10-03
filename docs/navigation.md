# Workspace navigation — issue 26

## Mobile workflow update — issue 45

Below 768 CSS pixels, **Menu** (☰) expands account/preferences, Help, sync,
reviews, export and defaults. The three destinations stay directly reachable;
the visible **Lists** label retains the accessible name **List Workspace**.
The compact status disclosure uses text, a symbol and color for confirmed,
pending, offline or failed saves. Expand it for account and offline-readiness
details. Update instructions, errors, failed-save comparisons and storage
recovery remain in the workspace.

Task/list/project titles now open the existing text editor directly, retaining
its account-bound draft, validation, conflict handling and focus restoration.
Tasks keep a named completion/reopen icon; mobile Clarify, Brief and undo actions
live in a three-dot disclosure. Expanded actions survive background refreshes.
Escape closes a focused disclosure and returns focus to its summary. Desktop
utility/action disclosures are expanded; resizing to mobile collapses them.

General instructions live in the app's **Help** page, opened in a separate tab
to preserve the current workflow. Shell v19 caches Help for offline use, updates
the full module graph and verifies upgrades from v3–v18 without changing stored
drafts or queued intents. No API, data schema or dependency changes are needed.

`api/test/mobile-workflow.test.mjs` checks the mobile menu, title editing,
background-refresh focus, offline Help, retained drafts, visible storage-error
recovery, 44px controls and overflow at 320/390/1440px in both themes. Existing
browser checks open disclosures through real clicks before using utility actions.
Generate [screenshots](design/mobile-workflow/) with `MOBILE_SCREENSHOTS=docs/design/mobile-workflow`
and run that test with the repository's Node test command. Physical phones and
screen readers remain release verification gates; browser emulation is not a
claim that those checks passed.

[Phone work view](design/mobile-workflow/work-dark-390.png) ·
[Narrow capture](design/mobile-workflow/capture-light-320.png) ·
[Desktop work view](design/mobile-workflow/work-light-1440.png).

## Design decision before implementation

Use three native links, /#capture, /#work and /#lists. Links provide ordinary keyboard navigation, opening in another tab and browser history without a router or extra server routes. The current link has aria-current=page, an underline and a border. The existing HashiCorp-derived tokens, native forms and responsive panels remain the design reference.

Capture is the fresh-entry default and shows only the capture form. Your Work reviews all canonical actions with list/status filters. List Workspace requires a selected list and exposes its items, title/notes and defaults, plus New list. A missing/deleted list returns to Choose a list, never silently shows all work. Review and list selections/status filters are independent, account-bound draft metadata. URLs contain only the destination, never IDs or task text.

The [phone/desktop HTML mockup](design/navigation-mockup.html) shows the three proposed destinations together for review; the implementation displays only one. Shared account, sync, errors, conflicts and recovery tools remain outside the changing panels. Navigation is in normal document flow so it cannot cover capture controls or a phone keyboard.

Reload and back/forward follow the URL; absent or unknown destinations use Capture. Saved legacy workspace mode does not override the URL. Views cannot reveal records until session verification opens the account cache. Account changes clear displayed filters and return to Capture. Navigation never submits or resets forms; capture/editor/default drafts and the outbox continue to use the existing journal.

On link activation and back/forward, focus moves to the destination heading (Capture focuses its text input). An open modal retains focus until closed; afterward focus moves into the active view if its opener is hidden or was replaced by rendering. A skip link reaches the active view. No custom tab keyboard contract is needed.

## Integration and verification

### Include and exclude status filters (issue #49)

In either Your Work or List Workspace, choose **Include statuses…** to show items
matching any checked status, or **Exclude statuses…** to hide those statuses.
Built-in and custom statuses are available. No checkboxes selected means no items
for Include, and all statuses for Exclude. For example, exclude Completed and
dropped to focus on unfinished, retained work. The Incomplete items default and
single-status, All statuses and Ready for review presets remain available.

The list/project/day scope still applies. Each destination saves its own mode and
selection in the account's device draft for navigation and offline reload. Filter
changes do not queue task edits. Account switching clears the displayed choices.

The browser regression in `api/test/status-filters.test.mjs` covers both modes,
empty selections, custom status text, scopes, keyboard focus, independent
destination preferences, offline reload, account isolation and 320/390/1440px
layout. Shell v20 delivers the controls to installed clients, with upgrade checks
preserving drafts and exact queued operations from shells v3–v19. These are local
automated Edge checks; physical-device and screen-reader checks remain unverified.

### Completed task visibility (issue #43)

Your Work and List Workspace default to **Incomplete items**, hiding completed
tasks across account, inbox, list, project and planned-day views. Waiting and
deferred tasks remain visible. Choose **Completed** to review finished work or
reopen an accidentally completed task; choose **All statuses** to see both.
The same list/project/day scope still applies. Completing a task removes it from
the default view immediately after the device save; it does not delete it.

Each destination retains its selected filter for the current account across
navigation and offline reload. The former default (empty status filter) now means
Incomplete items; saved specific-status filters are retained. All statuses is an
explicit saved choice. If completing or reopening removes the focused row,
keyboard focus returns to the view heading. Exports still include completed tasks.
Weekly review sessions retain their existing active-work queue; completed project
work can be inspected with the project view and Completed filter.

Shell v18 includes the filter change for installed/offline clients. Automated
navigation checks cover scoped filters, independent destinations, offline
completion/reopening, saved choices, keyboard focus and account switching.

PR #31 merged while this work was in progress and was integrated from main at 84f49c6. Projects, outcomes and planned-day filters remain available in Your Work; list management stays in List Workspace. The planned day and review filters survive switching away and returning. PR #32 was subsequently merged from main at 36277d7, retaining PWA installation/update behavior and its browser synchronization wait fixes. The combined release uses shell/module version 9, preserving account data and exact queued operations while older worker versions remain active.

Recorded October 2, 2026 on Windows with Node 26.7.0 and Microsoft Edge 154.0.4258.48. Automated tests use production handlers with the existing in-memory Cosmos substitute. The navigation scenarios are in api/test/navigation.test.mjs; existing inbox, security, account-sync, design and project tests are retained.

| Check | Expected and observed |
| --- | --- |
| Fresh entry, direct links, reload, back/forward | URL chooses the destination; filters and drafts stay with the verified account |
| Offline capture → review → list → edit/move/complete → capture | Exact pending operation retained during navigation; one canonical record after reconnect; original and unsent capture retained |
| Modal open during history navigation | Focus remains inside the editor, then returns to the visible destination on close |
| Rejected saves and quota failures | Comparison, export and recovery text remain reachable from all destinations |
| Account switch and expiry | Private content, selected list, filters and failure details disappear; changing the hash cannot bypass verification |
| Deleted selected list | Choose a list / no-list state, without silently showing unrelated work |
| Keyboard and appearance | Native links, one aria-current marker, visible focus/underline, skip link and 44px targets |
| Layout | No horizontal overflow at 320/390/768/1440/2560 CSS pixels in dark and light themes; 200% text enlargement at 720px also passes |

[Phone proposal](design/navigation-proposal-390.png) · [Desktop proposal](design/navigation-proposal-1440.png).
Final screenshots: [Capture phone](design/navigation/navigation-capture-dark-390.png), [Your Work phone](design/navigation/navigation-work-dark-390.png), [List Workspace phone](design/navigation/navigation-lists-dark-390.png), [Capture desktop](design/navigation/navigation-capture-dark-1440.png), [Your Work desktop](design/navigation/navigation-work-dark-1440.png), [List Workspace desktop](design/navigation/navigation-lists-dark-1440.png), [light phone](design/navigation/navigation-work-light-390.png), [light desktop](design/navigation/navigation-work-light-1440.png). They include keyboard focus on the current destination.

From the repository root, reproduce screenshots with NAVIGATION_SCREENSHOTS=docs/design/navigation and run node --experimental-test-module-mocks --test api/test/navigation.test.mjs (set PLAYWRIGHT_CHANNEL=msedge on Windows). The proposal HTML and screenshots were prepared before the implementation.

Physical phone keyboard/safe-area behavior, assistive-technology announcements, actual browser 200% zoom, non-Chromium browsers and deployed SWA/Cosmos remain unverified. Automated text enlargement/reflow is not a claim of a physical-device or browser-zoom check. Keep issue #26 open for that evidence. No new workflow or persistence protocol was introduced.

Final verification at implementation commit `0625415`: all **56 tests pass**, none skipped, with `PLAYWRIGHT_CHANNEL=msedge node --experimental-test-module-mocks --test api/test/*.test.mjs`. `git diff --check` passes. This initial verification preceded the PWA integration and CI repair below.

## CI follow-up

The first Linux CI run exposed two timing-dependent assertions: the design check read visibility before hashchange applied the new destination, and the navigation check read focus before the native dialog close event. Both now wait for the observable completion state, without arbitrary delays or weaker assertions. Async IndexedDB predicates reuse the browser wait helper merged in PR #32.

After integrating main at `36277d7`, all **65 tests pass** locally via `cd api; npm test`, using Node 26.7.0 and Playwright Chromium 153.0.8010.12 on Windows. This includes PWA updates and preserved queue/draft upgrades from shell v3–v8. Shell v9 updates all module URLs, PWA asset caching and the readiness handshake together. The original screenshot layouts remain unchanged apart from the newly merged PWA status/install controls.

The final pre-push check also found PR #33 merged at `e78baf8`. Its waiting/deferred states, undo, date validation and Ready for review filter are integrated. The workflow browser check now verifies that Ready for review survives Capture/List Workspace navigation and offline reload, with independent list filters.

Final combined verification: all **70 tests pass**, none skipped, on Playwright Chromium 153.0.8010.12 / Node 26.7.0. The new workflow store-to-fields module import also uses v9, so every transitive dependency is available after offline reload. `git diff --check` passes.
