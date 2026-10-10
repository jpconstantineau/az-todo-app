# Browser state contract

The first-release local store is IndexedDB `todo-inbox-v1`, database version 1,
with one `accounts` object store. There is no migration from unreleased draft
generations. Database version and shell cache version are independent: a shell
update preserves current drafts and exact pending operations. Future incompatible
state changes require an explicit schema/version decision, not fallback readers.

## Session and account documents

- `session` initializes with `activeProfile: "device-local"`. Once verified it can
  also contain `accountId` and boolean `paused`. `activeProfile` chooses the
  visible local or account profile, while `adoptLocal` records only the user's
  explicit **Sign in to sync** intent. Sign-out pauses the account and returns to
  the local profile without deleting either profile's data.
- `local-profile` has the same records, queue, cursor, drafts and defaults shape
  as an account document, but lives outside the `account:<accountId>` namespace.
  Its operations use the reserved local owner `device-local` and never go to the
  API. Built-in defaults are available locally without an account.
- `account:<accountId>` starts as `{ records: {}, queue: [], after: 0, draft: {} }`.
  `records` contains confirmed canonical records keyed by `type:id`; `after` is
  the last applied change cursor. Optimistic records are projected from the queue.
- `queue` entries contain the exact v1 `operation` (account, operation ID and
  version-checked mutations), optionally `failure` and a conflict `receipt`.
  Intent and its draft changes commit in the same transaction. A retry retains
  the operation ID and payload; reload never reconstructs or rebases a save.
- `defaultSettings`, when fetched, caches the API's built-in defaults. A current
  `settings:settings` record overrides them. No archived settings source exists.
- `selectedWorkspace` is absent until chosen (Personal is the initial selection).
  `draft` belongs to Personal; `workspaceDrafts` is created on first use of another
  workspace and maps workspace IDs to independent draft objects.
- Optional `undoEdit` stores the last editor save's record identity/title,
  `expectedVersion`, `operationId`, `expiresAt`, and inverse `fields`. It is removed
  when undone or invalidated by a competing edit; it is not a second outbox.

## Workspace drafts

An unused workspace has `{}`. Journaling writes `workspaceId`, `capture`, `edit`,
`editOpen`, `defaults`, `defaultsOpen`, `clarification`, `brief`, `day`,
`navigation`, `review`, and `extraction`. Empty/null workflow snapshots mean
that workflow has not been opened; these are normal current states, not migrations.
Portable imports still accept the removed `collectionUtility` key so older
recovery copies remain readable, but the client ignores it and does not save it again.

- Capture contains only `text`, `body`, `listId`, `newList`, and `contexts`, plus
  `original` after explicit split preview. `listId` is empty, a list ID, or a
  `project:<id>` destination. Saving clears it to `{}`. Dates and other advanced
  attributes belong to the item editor or reviewed extraction suggestions.
- A non-null editor draft contains `type`, `id`, `version`, complete form `fields`
  and complete `initialFields` from when editing began. Form values include
  collection references, workspace, dates and metadata; new collection drafts
  keep `parentRef` as a form string and project lifecycle is `projectStatus`.
  Existing collection type, parent and `revisitDate` save directly from Organize
  rather than entering the editor draft. Restoration keeps both the
  edits and their baseline, even if the cached record changed. Drafts without
  `initialFields` are unsupported and are never reconstructed from server data.
- Defaults contain record identity/version and form `values`. `editOpen` and
  `defaultsOpen` explicitly control reopening. A new list draft remains available
  through New list without opening on arrival.
- Navigation uses separate `work`, `lists`, and `execute` objects. The URL chooses
  the destination; old top-level view/status/mode values are not restored.
- Review keeps `active`, `selected`, and `deferUntil`; clarification and brief
  snapshots retain the current workflow's proposal/revision and position.
  Extraction retains its current capture snapshot, clock and reviewed suggestions.

Missing optional containers initialize an unused workflow; they do not select an
older format. Development data from unsupported generations can be cleared after
exporting anything needed. The app never automatically deletes it or its queue.

After **Sign in to sync**, the verified account adopts local work only when the
persisted `adoptLocal` intent is present. One IndexedDB transaction copies the
local profile into the destination account and rewrites only each queued
operation's owner; operation IDs, payloads and order remain exact. Existing
destination server records, cursor, defaults and metadata are preserved. A
destination queue, meaningful draft or recovery workflow blocks adoption and
leaves both profiles unchanged for explicit recovery.

**Menu → Data & recovery → Restore from cloud** (or **Clear device data** in the
local profile) uses a routed review before it deletes `todo-inbox-v1`. The
inventory names the active profile's pending/failed operations and meaningful
workflow drafts, lists collection-move and editor-undo
recovery separately, and shows only aggregate counts for inactive accounts and
the local profile. It does not treat navigation or filters as drafts. Confirmation
rechecks the online identity for an account, the profile generation and a fresh
inventory fingerprint under the sync lock; any change refreshes the review instead
of clearing data. Clearing resets all profile documents on that browser, while the
installed shell and downloaded
exports remain outside the database.

## Recovery and verification

Device JSON and readable exports preserve confirmed records, exact queue entries,
the saved and current drafts, workspace drafts, cached defaults and edit undo.
Unsupported fields and missing editor baselines are reported without dropping
their recovery text. See [device exports](device-export.md).

Browser tests cover current editor baseline restoration, empty metadata on a
fresh capture, workspace drafts, review/clarification position, undo, account
switching, storage failures and offline reload. Shell-update tests preserve the
exact pending operation and draft through failed installation and activation,
then verify the original receipt once connectivity returns.
