# Portable device and server exports (issue #13)

Choose **Portable JSON** or **Readable text** beside **Export device copy**.
Export includes all records cached for the current account, regardless of the
selected list, project, day or status filter. It works offline after the updated
shell has installed. It never submits pending saves or modifies records.

This is a **device copy**, not a complete server backup. Choose **Sync now** first
when online, and resolve failed saves if you want a confirmed snapshot. Even then,
another device can commit more changes after this device's last pull. The export
records that pull's cursor; it does not claim a global point-in-time snapshot.

## Complete server record copy

Choose **Export server copy** in Menu, using the same JSON/text selector. This
reads committed v1 records for the authenticated account from all devices, even
records this browser has never synced. It ignores view filters and does not
submit pending saves, read or modify IndexedDB, or change a sync cursor. Keep a
device copy as well for local drafts and unacknowledged work.

The first page pins the account's visible history sequence. Every subsequent
page uses that cutoff; replaying immutable entries reconstructs each record's
latest version at that sequence. Concurrent edits, creations and deletions above
the cutoff are excluded. This is a logical history snapshot, not a wall-clock
timestamp guarantee or an Azure database backup. The deployed consistency and
history invariants in [the API contract](data-api-v1.md) still apply.

`todo-account.json` uses `format: "az-todo-account-export"`, `formatVersion: 1`,
`scope: "account"`, and `source: "server-history"`. `state.after` is the fixed
cutoff. `state.records` preserves all record fields, originals, relationships,
settings, clarification progress, reviews and every separately stored brief
revision/decision, including tombstones. Immutable migrated legacy defaults are
included separately. Queue and draft fields are empty: they never imply that
local work was saved on the server. `exportedAt` records export completion.

The export is a portable current-record copy. It excludes older overwritten
record versions, rejected conflict proposals, receipt hashes, Cosmos metadata,
legacy migration archives beyond defaults, auth-provider information and Azure
backups. Tombstones retain their stored content under the existing retention
policy; exporting them does not restore them. No server purge or account erasure
is performed by export.

`todo-account.txt` labels the cutoff and renders live/deleted snapshots and brief
acceptance in plain text. The same validation/round-trip CLI below accepts either
JSON format, preserves unknown fields with warnings, and refuses overwrites.
Neither format can be replayed into a live account by this tool.

Each request reads at most 50 history entries with the existing roughly 1 MB
page bound (one whole oversized entry is allowed), and times out after 15 seconds.
Progress and **Cancel export** remain available. Offline, expired sessions,
account changes, missing history and invalid pages fail without a partial file.
Retry starts a fresh cutoff. The browser stops after 50 MiB of serialized history
responses; larger accounts need an operator-assisted export or a future streaming
implementation. This bounds work even when many old edits collapse to few records.
Downloaded copies remain outside the app after sign-out or deletion.

## Contents and compatibility

### Undo the latest editor save

**Menu → Edit recovery → Undo last edit** restores the changed fields from the
latest item, list or project editor save in this browser profile and account.
The inverse patch and original save are journaled in the same IndexedDB
transaction. Reload, offline reopening and server acknowledgement retain it.
There is one recovery slot per account, replaced by the next editor save.
Creation and the separate defaults, clarification, review and brief workflows
are excluded; their existing recovery controls remain available.

Undo is available for seven days from the device save, using the device clock,
and only while the edited record's observed version remains unchanged. Another
local mutation of that record, a conflicting receipt, a newer remote version or
deletion invalidates it. Failed saves block undo until resolved. The click checks
the latest account transaction again, so another tab cannot replace the recovery
slot between display and submission. No background expiry timer is needed:
eligibility is checked on rendering and at submission.

Undo queues a new ordinary update with a new operation ID and the edited record's
expected version. It restores only the fields changed by that editor save;
original captures, source metadata and unsaved form drafts remain intact. Missing
optional values are restored using the API's empty/null representation. There is
no redo. If another device edited or deleted the record, or changed a referenced
list/project, normal server validation and conflict handling apply. Historic
invalid values may also need manual recovery rather than a now-invalid update.
The proposed inverse stays recoverable in a rejected outbox entry and export.

The undo window is a device convenience, **not a server erasure/retention policy**.
An undo queued during the window may sync later. The recovery entry is not sent
to other devices, but the resulting update syncs normally. An expired entry may
remain in local storage until replacement/invalidation; device JSON and readable
exports include it. Server copies exclude device recovery metadata. Downloaded
exports, server change history, receipts and backups are not purged by expiry.
Clearing site storage removes this device's recovery slot and pending undo saves.

Shell v23 introduces this additive account-state field without a database or API
migration. Earlier clients can still submit normal updates; any same-record
version change makes recovery unavailable. The upgrade suite covers v3–v22.
Focused checks cover all three record types, expiry, acknowledgement, invalidation,
offline reload and sync, drafts, account switching, stale deletion conflicts and
export preservation. [Layout screenshots](design/edit-undo/) cover 320/390/1440px
in both appearances. Real SWA/Cosmos, physical devices and screen readers remain
unverified.

On October 2, 2026, all **153 tests passed**, none skipped, in an isolated Windows
worktree with Node **22.23.3** and Playwright Chromium **153.0.8010.12**. This run
includes main at `c897130` (PRs #54 and #55), the final undo conflict checks, and
shell upgrades through v22. Run from `api/` with Node 22:
`node --experimental-test-module-mocks --test test/*.test.mjs`.

`todo-device-recovery.json` uses `format: "az-todo-device-export"` and
`formatVersion: 1`. The existing recovery fields `accountId`, `state` and `draft`
are retained. Additional metadata records `exportedAt`, `scope: "device"` and
`source: "indexeddb"` (or `"memory-recovery"` if the storage read failed).

- `state.records` retains canonical IDs, account IDs, versions, exact originals,
  source/selection/link data, list/project relationships, outcomes, dates,
  statuses, defaults and deletion markers. Workflow calendar dates and the prior
  transition/completion metadata used by undo are retained. No field is projected
  away or trimmed.
- Brief records retain immutable content, source references, previous revision
  IDs and acceptance/rejection decisions. Readable output labels each revision;
  [selected-revision export](briefs.md) is also available from the brief panel.
- `state.queue` retains exact operation IDs, expected versions, proposed fields,
  failures and conflict receipts, including competing server versions. A failed
  pending edit never replaces the confirmed record in the exported snapshot.
- `state.draft` is the stored draft; top-level `draft` is the form at the moment
  export was requested, including text whose local save failed. Both are kept.
- The remaining account state, including cached defaults and the change cursor,
  is retained. Navigation or future fields are preserved even if the validator
  reports that their interpretation is unsupported.

Export reads the account's latest IndexedDB snapshot, so another tab's committed
local writes are included even if its change notification has not arrived. If
IndexedDB cannot be read, export uses the current in-memory copy and labels it
`memory-recovery`; that fallback may lack newer writes from other tabs. A changed
account/session while the read is pending cancels the download.

`todo-tasks.txt` opens in an ordinary text editor. It separately labels confirmed
record snapshots, deleted records, pending saves and drafts, with IDs and all
record fields. Tombstones are explicitly marked as inactive. Text is exported
as plain text, not executable HTML. JSON is the lossless recovery format.

The export contains private task text and stable account identifiers. Keep copies
in storage you control. Downloaded files are outside the app and remain after
sign-out, site-storage clearing or deletion of a record.

## Offline validation and round-trip rehearsal

With Node 24+, from `api/`:

```text
node scripts/validate-device-export.mjs todo-device-recovery.json
node scripts/validate-device-export.mjs todo-device-recovery.json roundtrip.json
```

The first command validates either envelope, record identities/owners, cursor,
operation identities/versions, and receipt/conflict ownership. It reports counts
and unsupported fields/types without intentionally printing task bodies. The
second command serializes the validated contents to a **new** file; it refuses
to overwrite an existing file. Unknown fields and future record types produce
warnings and remain intact. Invalid ownership/identity or unsupported envelope
versions fail. Old raw recovery files without the format marker remain useful
manual backups but are not accepted by this new validator.

This is a validation/round-trip harness, not a live restore or full API-write
validator. It never contacts Azure, writes IndexedDB, resets cursors or replays
queues. Do not put its output directly into a live account. A future restore must
reconcile current versions, tombstones, receipts and account-erasure policy first;
pending intent in an old export cannot authorize resurrecting erased work.

## Verification and remaining issue scope

Node and Playwright checks exercise exact JSON round-trip, originals and links,
relationships/dates/statuses, settings, tombstones, pending conflicts, unsupported
field reporting, overwrite refusal, two-account isolation, offline reload, latest
cross-tab state, and storage-read failure with recovery of current form text.
The existing responsive and shell-upgrade tests cover the added native selector
and cached export module. No database or IndexedDB schema migration is needed.
After integrating PRs #32, #33 and #34 from main, local verification on October 2,
2026 passed all 76 tests with Node 26.7.0 and Playwright Chromium on Windows (`npm test`).
The combined navigation, workflow, PWA and export shell uses v10; upgrade checks
cover v3–v9. Export tests verify downloads from all three navigation destinations
while preserving the current capture draft and ignoring the selected filters.
Export tests use the shared asynchronous browser-state wait helper from main.
Real-device download UX and deployed Azure data behavior are unverified.

Clarification, review progress and brief revisions are now supported by the device
export and its validator. Pending deletes project as inactive, and stale queued
edits cannot reactivate a local or server tombstone. The original queued intent
remains available for conflict review and export; the confirmed snapshot is never
rewritten by projection.

Server-copy checks cover fixed-cutoff paging during concurrent writes, tombstones,
conflicts, empty accounts, account isolation, malformed/gapped pages, bounded
work, JSON round-trip, cancellation, expiry, offline failure and delayed responses
after account switching. Browser checks confirm remote-only work appears without
changing device data and inspect 320/390/1440px layouts. Shell v22 includes main's
status filters and deletion fix and upgrades from v3–v21 without discarding local data. These tests
use the in-memory Cosmos substitute; deployed Cosmos/authentication, physical
device downloads and assistive technology remain unverified.

On October 2, 2026, all 128 tests passed on Windows with Node 26.7.0 and
Playwright Edge (`PLAYWRIGHT_CHANNEL=msedge`, `npm test` in `api/`), based on main
at `2a62689` including PRs #51 and #52. [Layout screenshots](design/account-export/) use
the browser test's optional `EXPORT_SCREENSHOTS` output directory. The export
browser cases block service workers to inject request failures; the separate
PWA suite verifies shell delivery, cache boundaries and upgrades.

## Recoverable record deletion

Choose **Delete** in an item's actions or beside the selected list/project.
Confirm the named record. Only empty lists/projects can be deleted: move or delete
their active items first. Deletion is journaled on device, works offline, and
survives reload. **Menu → Deleted records** shows deleted items, lists and projects
and offers **Restore**, including while a deletion is still queued offline.
Restore a deleted parent list/project before restoring its items. Record identity,
original text, links, attributes and relationships stay intact.

There is **no automatic purge and no recovery deadline** in this implementation.
Deletion hides a record from active views; its text remains in the tombstone,
receipts and change history. Associated clarification, reviews and brief revisions
remain stored and exported. Restoring a source does not rewrite their historical
versions or decisions. Downloads, other devices and Azure backups are not erased.
This is recoverable deletion, not account erasure or a promise of permanent removal.

Restore is a distinct version-checked operation, never a create/update against a
tombstone. Stale offline writes and old restores cannot resurrect a later deletion.
A failed delete/restore blocks the queue and preserves its intent for export;
review the server version and explicitly remove the rejected save before retrying.
No later queued edits are silently rebased. Other devices observe deletion and
restoration at their next foreground sync, not through server push.

Existing drafts are retained when their record is deleted. Saving an old editor
draft requires explicit comparison with the latest record; it cannot recreate a
deleted source. Device exports retain queued `restore` operations; JSON validation
and the round-trip harness preserve them. Old clients can read restored records,
but must upgrade before validating exports containing the new operation. Deploy
the API support before the new shell; rolling back the API rejects restores and
keeps queued intent for recovery rather than silently rewriting it.

`v1.test.mjs`, `delete-projection.test.mjs` and `deletion-browser.test.mjs` cover
restore validation, account isolation, lost acknowledgements, stale versions,
transaction failure, parent deletion races, export/reload, independent-client
conflicts, offline delete/restore and 320/390/1440px light/dark layouts. These use
the in-memory storage substitute. Deployed Cosmos/authentication, physical devices
and screen-reader behavior remain release gates. Shell v24 includes both edit undo
and the recovery view, upgrading from v3–v23 without resetting IndexedDB.

Local verification on October 2, 2026 (Windows, Node 26.7.0, Playwright Edge):
`npm test` in `api/` passed 149/150 tests. The sole failure was Windows `spawn EPERM`
starting Chromium for the existing unpacked-extension test; rerunning that exact
test outside the sandbox passed (1/1), covering all 150 tests across both runs.
The [recovery screenshots](design/deletion/) show the light/dark layouts.
CI remains responsible for the configured Node 22 Linux run.

After integrating main's edit undo and Cosmos rehearsal on October 3, 2026,
the combined Chromium run passed 163/164 checks on Windows/Node 26.7.0. The
offline browser-restart cache assertion missed one unversioned asset; its isolated
rerun passed. The deletion CI failure was an immediate assertion before IndexedDB
validation completed; it now waits for the error and completed deletion before
checking state. The merged browser case also checks that remote deletion clears
edit undo. Shell v24 gives the combined release distinct module/cache URLs.

Account erasure, permanent purge and backup-erasure/restore policy remain open
under #13; this change covers recoverable item/list/project deletion only.
