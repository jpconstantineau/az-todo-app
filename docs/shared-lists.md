# Shared shopping and family lists (#42)

Open **Menu → Shared lists**. Create a list, add items, then expand **Manage list
and sharing**. Choose an invitation's permissions and copy its link to the person
you want to invite. They sign in and explicitly accept it. Invitations expire in
seven days, work once, and can be cancelled before acceptance. The invitation
code is removed from the visible URL and retained in the current tab through
sign-in; it is never sent in a query string or Referer.

Every member can view. Owners independently grant **add**, **edit title**,
**complete/reopen**, and **delete/restore item**. Members cannot rename the list,
invite others, change permissions or delete the list. Owners can change grants
or remove members immediately. No action is sent to another person automatically.

Shared lists use a separate page and data path. Private lists, projects,
workspaces, reviews and briefs are not exposed or copied. Existing private lists
remain private; this release creates new shared lists. Ownership stays with the
creator, without ownership transfer. A deleted shared list is recoverable by its
owner, with its item contents intact; deletion revokes all memberships and
invitations, and restoration does not regrant access. There is no automatic purge.

## Offline work, conflicts and export

Wait for **Ready to reopen shared lists offline** on this page before closing it
offline. Each account has its own saved shared-list snapshots, add/edit drafts and
one durable pending action. A transaction must complete before an action is
reported saved on device. Retry preserves the action ID and exact contents after
a lost acknowledgement. One pending action intentionally blocks further saves
until it is confirmed or removed; typed text remains available. Account changes
hide the previous account's content and never reassign pending actions.

Reopening, returning to this page, reconnecting or **Refresh and sync** checks the
session, submits pending work and pulls current data. There is no live push or
background-sync guarantee. Members see their latest downloaded copy while
offline. Revocation cannot erase copies or exports already on someone's device;
on reconnect the server refuses their reads/writes and the page removes its
selected cached list. The rejected action stays in recovery so its author can
export the text or remove it. It is never uploaded under a different account.

Concurrent changes conflict at whole-list revision granularity. The pending
action is retained. **Review and apply to latest list** shows the current item and
the proposed action, then requires explicit confirmation and sends a new action
against that reviewed revision. Sharing/owner actions require removal and fresh
entry after a conflict. Deletion cannot be silently reversed by an old edit.

**Export shared device copy** downloads JSON containing cached shared lists,
drafts and the pending action. Invitation secrets are omitted. It is a recovery
copy of this device, not a full server backup or an import command. Private v1
server exports do not include shared lists. Unsynced work cannot be recovered
after browser storage is cleared or the device is lost.

## Storage and authorization

The existing authenticated SWA principal, exact-origin CSRF guard, JSON input
validation, no-store headers and `V1_API_ENABLED` deployment switch apply to
`GET /api/shared/lists`, `GET /api/shared/list?id=…` and
`POST /api/shared/operations`. List discovery uses the verified account in a
bounded, paginated membership query; a cursor never supplies authorization.
Cross-account sharing is limited to explicit membership of that shared list.

Each list uses `[shared:<listId>, shared-list, v1]` in the existing hierarchical
Cosmos partition key. The list's owner, grants, invitation hashes, revision and
items share one document. Each mutation replaces it with an ETag precondition
and creates a durable receipt in the same transactional batch. Grant changes and
content changes cannot race past one another. Uncertain responses retry the same
operation; different content with the same ID is rejected. Receipt replay checks
current access and returns only an acknowledgement, not an old content snapshot.
Only invitation hashes are stored on the server. Private account partitions and
their history are unchanged; there is no migration or reset.

The intentionally bounded first implementation allows 200 items including
deleted items, 20 members, 20 open invitations and a 200 KB list document. API
actions are capped at 8 KiB. Receipts remain durable without compaction. The
membership directory query crosses partitions; measure request units before
large deployments. Replace the bounded document and directory scan with indexed
membership plus a complete shared change-feed protocol if measured usage needs
larger lists, throughput or scalable discovery. Do not split grants from writes
without preserving atomic authorization and repeat-safe delivery.

Deploy the additive API before the updated web shell. The shell caches only
public assets; shared API responses, invitation codes and account data never
enter Cache Storage. Stored device copies remain account-scoped in IndexedDB.

## Verification

`api/test/shared-lists.test.mjs` covers every permission, invalid and foreign
requests, one-use/expired/cancelled invitations, revocation, repeat-safe creation,
lost acknowledgements, atomic rollback and concurrent writes, plus whole-list
deletion/restoration. The common security suite covers the new routes too.

`api/test/shared-browser.test.mjs` runs separate owner/member sessions, constrained
controls, offline reopen, a saved offline conflict, explicit resolution, revoked
offline actions, account switching, editing/deletion/restoration, safe text,
export and 320/390/1440px light/dark layouts. Current screenshots are in
[`design/shared-lists`](design/shared-lists/). These are local handler/IndexedDB
tests with the existing in-memory Cosmos substitute. Real SWA accounts,
production Cosmos concurrency/query costs, physical phones and assistive
technology remain deployment validation gates under #42/#17.

## Shared-item keyboard navigation (#16)

Complete and Reopen keep focus on the same item's action, even when two items
have identical titles. Background refresh preserves the focused item and action;
closing or saving the editor returns to that item's Edit button after a rename.
Deleting/restoring an item moves focus to the list heading because the original
action has left its section. If access disappears, the list selector is the
fallback. Disabled actions use the heading while a save is pending; after
confirmation, focus returns only if the user has not moved to another control.
Account changes discard the old focus target.

`api/test/shared-keyboard.test.mjs` covers keyboard-only complete/reopen/edit,
duplicate titles, remote rename/deletion, modal draft retention, delayed refresh,
offline acknowledgement and account changes. The shell versions the shared
module URL as well as the existing module graph, so an older worker cannot serve
a stale shared module to the new page. Browser automation does not replace the
screen-reader and physical-device verification still required by #16/#17.
