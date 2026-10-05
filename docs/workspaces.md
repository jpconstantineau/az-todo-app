# Workspaces (#46)

Use **Manage workspaces** to create Work, Family, Volunteering or other named
spaces, then choose one with the Workspace selector. Capture, lists, projects,
planned-day/status views, deleted records and daily/weekly reviews use that
selection. Names are plain text and may be renamed. The selector and management
dialog use the existing native controls, charcoal surfaces, spacing and focus
styles from DESIGN.md; there is no new navigation framework.

Existing records and device drafts belong to **Personal** without being rewritten.
Personal remains available as the default destination for old clients and browser
handoffs; it cannot be renamed, archived or deleted. Create a named workspace for
work that should later be archived as a whole.

Each workspace keeps its own capture, editor, clarification, brief, AI-suggestion and review
drafts, list selection and filters on this device. Switching saves the current
draft before displaying the destination. Offline reload remembers the last
selected workspace. Same-profile tabs share each workspace's draft slot, as they
previously shared the Personal draft slot; they do not share live form buffers.
Different browser profiles have independent drafts. Account changes clear the
display and cannot carry the workspace selection into another account.

## Archive, deletion and recovery

- **Archive** makes the whole workspace read-only. Tasks remain visible. Use
  Manage workspaces → Unarchive to resume work.
- **Delete** hides the whole workspace and prevents new edits to its contents.
  Manage workspaces → Restore brings it back with the same identities, contents,
  drafts and history. Restoring an archived workspace leaves it archived until
  explicitly unarchived.
- Both actions are one version-checked, repeat-safe operation on the workspace
  record. They do not loop over tasks or partially delete large collections.
- This is recoverable deletion, **not erasure**. There is no purge or retention
  deadline. Records, review/brief/clarification history, receipts, exports and
  backups remain stored. Individual record deletion still has its existing rules.
- Offline saves made before a workspace change may already have committed.
  Later saves against an archived/deleted workspace are rejected by the server;
  the device retains the failed intent and stops its queue. Export a copy before
  removing a rejected save, then restore/unarchive and deliberately reapply any
  work needed. Rejected operations are never silently reassigned to Personal.

## Membership and moves

Lists, projects and review sessions belong to the workspace where they were
created. Items may be moved with the Workspace field in the item editor. Moving
clears list/project links so unrelated work cannot become linked across spaces;
choose new links after opening the item in its destination. The item retains its
ID and original text. Clarification and brief history follow that item (or their
project source). An existing review retains its decision history, but a moved
item is unavailable to further decisions in its former workspace.

List/project/review membership is fixed. Moving an entire populated list or
project is outside this change; it needs a separately defined atomic move
protocol. Items can be moved individually today. User defaults, the outbox,
conflict recovery and device/server exports remain account-wide. Both export
formats include all workspace records and retained contents; device exports
also preserve every workspace draft. Exports are recovery copies, not imports.

## Protocol and upgrade

The account partition, record IDs, receipts, history cursor and IndexedDB schema
are unchanged. `workspace` is an account-owned v1 record type with a required
`title` and boolean `archived`. It supports create/update/delete/restore using the
same expected-version rules. `workspaceId` is optional on legacy item/list/project/
review records; absence means `personal`. New clients explicitly assign it on
creation. Only items allow membership updates. Clarifications derive membership
from their item; briefs derive it from their source.

Every mutation validates workspace existence and writable state, plus matching
list/project/review relationships. Validation runs inside the account-state ETag
retry loop, so a concurrent archive/delete and edit cannot bypass the boundary.
Deleted children remain retained snapshots; readers use the workspace tombstone
to hide the collection. Authenticated account exports and sync still include
retained records. Workspaces organize one owner's data; they are not separate
accounts or a cross-user access-control/sharing system.

Deploy the compatible API before the client. The shell versions and caches the
entire module graph, including `workspaces.js`, while keeping existing queues and
drafts. Older open clients do not understand workspace filtering and may display
the owner's records together; close all app tabs/windows to activate the update
on every device before relying on separated views. The server still rejects
edits in archived/deleted spaces from old clients. Do not roll the API back to a
contract that rejects workspace operations while such queues exist, and never
reset storage or strip membership to make an old client appear compatible.

## Verification

Run `npm test` from `api/`. Focused checks:

```
node --experimental-test-module-mocks --test api/test/workspaces.test.mjs api/test/workspaces-browser.test.mjs
```

Automated checks use production client/API code, browser IndexedDB and the
existing transactional Cosmos substitute. They cover relationship rejection,
archive/delete write protection, repeated lost acknowledgements, restoration
without rewriting children, legacy Personal membership, offline drafts/filters/
reviews/moves/reload, account switching and 320/390/768/1440px layouts.

[320px workspace](design/workspaces/workspaces-320.png) ·
[390px workspace](design/workspaces/workspaces-390.png) ·
[768px workspace](design/workspaces/workspaces-768.png) ·
[1440px workspace](design/workspaces/workspaces-1440.png).
Set `WORKSPACE_SCREENSHOTS=docs/design/workspaces` when running the browser test
to reproduce them. The PR records the final integrated commit and suite result.
Physical-device, spoken screen-reader and deployed SWA/Cosmos verification are
not established by these local checks.
