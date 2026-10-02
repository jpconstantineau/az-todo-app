# Workspace navigation — issue 26

## Design decision before implementation

Use three native links, /#capture, /#work and /#lists. Links provide ordinary keyboard navigation, opening in another tab and browser history without a router or extra server routes. The current link has aria-current=page, an underline and a border. The existing HashiCorp-derived tokens, native forms and responsive panels remain the design reference.

Capture is the fresh-entry default and shows only the capture form. Your Work reviews all canonical actions with list/status filters. List Workspace requires a selected list and exposes its items, title/notes and defaults, plus New list. A missing/deleted list returns to Choose a list, never silently shows all work. Review and list selections/status filters are independent, account-bound draft metadata. URLs contain only the destination, never IDs or task text.

The [phone/desktop HTML mockup](design/navigation-mockup.html) shows the three proposed destinations together for review; the implementation displays only one. Shared account, sync, errors, conflicts and recovery tools remain outside the changing panels. Navigation is in normal document flow so it cannot cover capture controls or a phone keyboard.

Reload and back/forward follow the URL; absent or unknown destinations use Capture. Saved legacy workspace mode does not override the URL. Views cannot reveal records until session verification opens the account cache. Account changes clear displayed filters and return to Capture. Navigation never submits or resets forms; capture/editor/default drafts and the outbox continue to use the existing journal.

On link activation and back/forward, focus moves to the destination heading (Capture focuses its text input). An open modal retains focus until closed; afterward focus moves into the active view if its opener is hidden or was replaced by rendering. A skip link reaches the active view. No custom tab keyboard contract is needed.
