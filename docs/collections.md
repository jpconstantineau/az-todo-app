# Lists and organization

Lists is one browser for ordinary lists, projects, areas, roles, initiatives,
programs and reusable reference lists. New list uses the existing editor with a
kind and optional parent. Projects still require a desired outcome. Existing
projects retain their IDs and history; changing between a list and a project is
not a kind edit. The New project and Add next action shortcuts remain explicit.

Open a collection to see its direct items and children. Include nested items
shows each item once, even when it has several matching memberships. Desktop has
a collapsible outline; the compact picker and breadcrumbs work at all widths.
The item editor and clarification's organization step share Organize in. A task
can belong to a project, area, both, several groups, or none. Membership and
workflow are independent: ordinary capture always enters Inbox, including when
a destination is already selected. An explicitly chosen Add next action is the
shortcut for already-clarified work.

The first selected list/project becomes its primary when there is no retained
primary. The editor's Primary memberships disclosure lets the user choose a
different primary. Only the primary list supplies list defaults; parent defaults
are not inherited. Context, time, energy and historical area tags remain editable.

## Reference lists and area tags

A reference list shows reference entries with the default Incomplete filter.
Use as checklist copies selected titles, notes and supplied links into a new
ordinary list. Copies get new item IDs and enter Inbox unless Create copies as
Next actions is explicitly checked. The source entries are unchanged. Each save
is one atomic operation: a list plus 1–19 entries. Choose a subset for larger
lists; there is no hidden truncation or automatic reset.

Create/link an area from a tag links the selected workspace's matching items to
an explicitly selected or newly created Area. It does not delete tags, merge
equal names, change defaults, or alter items in other workspaces. A batch links
up to 20 items, or 19 with a new Area. The form retains its target and tag through
reload; each later batch skips already linked items. Progress is reported after
each save. Sync failures use the existing outbox and conflict recovery.

## Additive storage contract

- `list.kind` is optional; absence means `list`. Supported non-project kinds are
  `list`, `area`, `role`, `initiative`, `program`, `reference`.
- Lists and projects have optional `parentRef: { type: "list" | "project", id }`.
  Each has one parent at most. Typed IDs keep equal list/project IDs distinct.
- `item.collectionRefs` is a required array of at most 20 unique typed refs.
  An empty array represents an unfiled item and is still authoritative.
- `listId` and `projectId` remain primary links for the UI. A combined refs and
  primary patch cannot name a primary outside the selected refs. Changing a
  primary link replaces or removes only that typed membership and preserves the
  other selected memberships.
- The shared pure membership implementation ships in both deployment roots;
  the contract test checks the two files are identical. Server and optimistic
  client projections therefore apply the same membership rules.
- References must exist in the account and share the writable workspace.
  Parents cannot form cycles. Validation and deletion/link queries are inside
  the account-state ETag retry loop, so concurrent moves cannot bypass them.
- A live child or member prevents collection deletion. One bounded operation
  may explicitly move/unlink its contents and delete the emptied collection.
  Restore retains references and requires destinations to be restored first.
  Moving collections across workspaces remains unsupported. Moving an item
  explicitly clears incompatible memberships.

Drafts, undo, comparison/recovery, device exports, server-history exports,
project reviews, project brief templates and Execute read the new membership
data. Existing saved review inventories and brief revisions remain immutable.
Old clarification requests without collection refs retain their original
meaning; new organization answers include the exact selected refs in their
final atomic decision.

Deploy the additive API before the updated client. The shell versions its entire
module graph and caches the collection modules. No IndexedDB reset or bulk record
migration occurs.
Older shells show only primary membership and cannot present nesting or all
memberships. Shared lists keep their separate permission-controlled interface;
private nesting does not grant sharing access.

Validation uses the existing API/browser suites, including concurrent cycles,
link/delete races, compatibility projections, offline drafts and rollups,
checklist source preservation and resumable tag mapping. Responsive screenshots
are in `docs/design/unified-lists/`. Physical-device and spoken screen-reader
testing remain manual follow-ups.
