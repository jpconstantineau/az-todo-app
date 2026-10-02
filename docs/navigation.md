# Workspace navigation — issue 26

## Design decision before implementation

Use three native links, /#capture, /#work and /#lists. Links provide ordinary keyboard navigation, opening in another tab and browser history without a router or extra server routes. The current link has aria-current=page, an underline and a border. The existing HashiCorp-derived tokens, native forms and responsive panels remain the design reference.

Capture is the fresh-entry default and shows only the capture form. Your Work reviews all canonical actions with list/status filters. List Workspace requires a selected list and exposes its items, title/notes and defaults, plus New list. A missing/deleted list returns to Choose a list, never silently shows all work. Review and list selections/status filters are independent, account-bound draft metadata. URLs contain only the destination, never IDs or task text.

The [phone/desktop HTML mockup](design/navigation-mockup.html) shows the three proposed destinations together for review; the implementation displays only one. Shared account, sync, errors, conflicts and recovery tools remain outside the changing panels. Navigation is in normal document flow so it cannot cover capture controls or a phone keyboard.

Reload and back/forward follow the URL; absent or unknown destinations use Capture. Saved legacy workspace mode does not override the URL. Views cannot reveal records until session verification opens the account cache. Account changes clear displayed filters and return to Capture. Navigation never submits or resets forms; capture/editor/default drafts and the outbox continue to use the existing journal.

On link activation and back/forward, focus moves to the destination heading (Capture focuses its text input). An open modal retains focus until closed; afterward focus moves into the active view if its opener is hidden or was replaced by rendering. A skip link reaches the active view. No custom tab keyboard contract is needed.

## Integration and verification

PR #31 merged while this work was in progress and was integrated from main at 84f49c6. Projects, outcomes and planned-day filters remain available in Your Work; list management stays in List Workspace. The planned day and review filters survive switching away and returning. This release uses shell/module version 8, preserving account data and exact queued operations while older worker versions remain active.

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
