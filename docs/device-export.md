# Portable device exports (issue #13)

Choose **Portable JSON** or **Readable text** beside **Export device copy**.
Export includes all records cached for the current account, regardless of the
selected list, project, day or status filter. It works offline after the updated
shell has installed. It never submits pending saves or modifies records.

This is a **device copy**, not a complete server backup. Choose **Sync now** first
when online, and resolve failed saves if you want a confirmed snapshot. Even then,
another device can commit more changes after this device's last pull. The export
records that pull's cursor; it does not claim a global point-in-time snapshot.

## Contents and compatibility

`todo-device-recovery.json` uses `format: "az-todo-device-export"` and
`formatVersion: 1`. The existing recovery fields `accountId`, `state` and `draft`
are retained. Additional metadata records `exportedAt`, `scope: "device"` and
`source: "indexeddb"` (or `"memory-recovery"` if the storage read failed).

- `state.records` retains canonical IDs, account IDs, versions, exact originals,
  source/selection/link data, list/project relationships, outcomes, dates,
  statuses, defaults and deletion markers. No field is projected away or trimmed.
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

The first command validates the envelope, record identities/owners, cursor,
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
After integrating PR #32 from main, local verification on October 2, 2026 passed
all 66 tests with Node 26.7.0 and Playwright Chromium on Windows (`npm test`).
The combined PWA and export shell uses v8; upgrade checks cover v3 through v7.
Export tests use the shared asynchronous browser-state wait helper from main.
Real-device download UX and deployed Azure data behavior are unverified.

This delivers the independently implementable export portion of #13. Workflow
progress and accepted brief revisions are not implemented yet; future fields are
retained and reported, not certified as supported workflows. Full server export,
undo/retention, live restore, account erasure and backup purge remain open under
#13 and its dependencies. There is no new deletion or resurrection path here.
