# Versioned data API (issues #4 and #25)

The native client at `/` exclusively uses this
JSON API. It is disabled unless `V1_API_ENABLED=true`; a disabled API shows a clear
error without choosing another store. Retired pre-v1 HTTP paths are unregistered
and receive the platform's normal not-found response. Existing v1 records, outboxes
and receipts remain compatible; no partition or database version changes are made.
The current v1 format is the only supported server format; retired migration
tooling and archived-settings fallbacks are not part of the runtime or recovery path.

## Recoverable deletion (#13)

An operation mutation may use `action: "restore"` for an `item`, `list` or
`project`, with its exact positive tombstone `expectedVersion` and no `fields`.
Restoring an active/missing record or an old tombstone version returns a durable
conflict. Successful restore increments the version, clears `deleted` and
`deletedUtc`, and retains stored content and identity. Existing relationship
validation requires active parents; restore the list/project before its items.
Account state, restored record, receipt and change commit in the same batch.
Retrying an operation ID returns its original receipt even after later deletion;
only newer versions replace client snapshots. Ordinary create/update/delete
operations still cannot mutate tombstones. No purge/expiry or partition migration
is introduced. See [retention and client recovery](device-export.md#recoverable-record-deletion).

## Partition decision (issue #27)

The additive [workflow contract](workflow-states.md) defines waiting/deferred
validation, calendar versus timed dates, and derived undo metadata. Existing
receipts remain repeat-safe; unacknowledged incomplete workflow transitions are
rejected with recoverable field feedback. Deploy that API before the updated client.

The [current clarification contract](clarification.md#current-record-contract) defines
`type=clarification` records with the same ID as an owned item. Proposals and
accepted answers remain separate from the task; final task changes and session
progress share an atomic operation.

The additive [brief contract](briefs.md#api-and-recovery) introduces immutable
content revisions with explicit acceptance/rejection. Draft creation and decisions
use the existing account transaction, receipt and conflict protocol. Deploy that
API before the updated client.

**Decision: retain the working account transaction boundary.** The physical
hierarchical paths remain `[/UserID, /ObjectType, /ObjectID]`; their v1 values are
`[accountId, "sync", "v1"]`. The last two field names are inherited partition
names, not task classification. Logical identity, storage ID and document kind
are separate:

| Storage ID | `kind` | Logical identity/classification |
| --- | --- | --- |
| `record:item:milk` | `record` | `record.type=item`, `record.id=milk` |
| `record:list:groceries` | `record` | `record.type=list`, `record.id=groceries` |
| `record:settings:settings` | `record` | `record.type=settings`, versioned user defaults |
| `receipt:<operationId>` | `receipt` | One immutable operation result |
| `change:<sequence>` | `change` | One ordered application history entry |
| `state` | `state` | Account sequence and ETag concurrency coordinator |

All are in the **same full key value** for their owner. A record's membership is
`record.listId`; moves change that relationship without changing its identity.
The existing `kind` and `record.type` already provide non-key classification.

| Option | Consequences | Decision |
| --- | --- | --- |
| Current account-wide `sync/v1` | One atomic list-plus-items/receipt/history/state batch; stable moves, ordered cursor and account-scoped reads. Same-account writers serialize; history grows. Different users have different partitions. | Keep; no evidence yet justifies a new protocol. |
| Derive ObjectType/ObjectID from storage-ID prefixes/individual IDs | Splits records, receipt, change and state across full keys; a single Cosmos transactional batch no longer covers them. Also changes point reads, queries and ownership/reference checks. | Reject for this protocol; would require a complete replacement for atomic acknowledgement and sync. |
| Add clearer non-key classification | Can improve tools/queries without breaking atomicity, but `kind` and `record.type` already express it. | Use existing fields; add metadata only for a concrete missing query. |
| New container with `/UserID` only | Clearer equivalent account-wide boundary, but no reduction in account contention/history growth. Requires new SDK key calls, transfer, coordinated cutover and rollback. | Defer until an operational need outweighs migration cost. |

This follows Cosmos's documented
[same-partition batch boundary](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch).
Changing ID-derived key values without a replacement protocol would lose atomic
capture, receipts and ordered history. No live documents, partition values,
queues or cursors are redistributed by this change.

### Read-only inspection

In authorized Cosmos tooling, bind `@account` to the stable account ID and scope
the query to the full partition `[accountId, "sync", "v1"]`. These deliberately
omit task text; never paste private records/auth payloads into issue reports.

```sql
SELECT c.id, c.record.type, c.record.id, c.record.version, c.record.deleted
FROM c WHERE c.UserID=@account AND c.ObjectType='sync' AND c.ObjectID='v1'
AND c.kind='record' AND c.record.type='item'

SELECT c.id, c.response.operationId, c.response.sequence, c.response.status
FROM c WHERE c.UserID=@account AND c.ObjectType='sync' AND c.ObjectID='v1'
AND c.kind='receipt'

SELECT c.id, c.sequence, c.response.status
FROM c WHERE c.UserID=@account AND c.ObjectType='sync' AND c.ObjectID='v1'
AND c.kind='change' ORDER BY c.sequence ASC
```

For list inspection replace `item` with `list`; use `kind='state'` to inspect
the sequence. These fields are filters, not substitutes for authenticated API
ownership validation. Never expose a database key to the browser.

### Measured fixture growth and operational follow-up

Run `node --experimental-test-module-mocks --test test/partition-profile.test.mjs`
from `api/`. The reproducible workload creates 100 items with 270-character notes,
then edits each five times (one item per operation), and pulls history at limit
50. Production validation/commit/change code runs against the existing mock.
Measurements below are serialized application JSON bytes excluding the mock
ETag, **not billed Cosmos storage** (indexes/system metadata are excluded).

| Document kind | After 100 creates: count / bytes | After 500 further edits: count / bytes |
| --- | ---: | ---: |
| Record | 100 / 96,460 | 100 / 96,460 |
| Receipt | 100 / 116,242 | 600 / 697,992 |
| Change | 100 / 108,836 | 600 / 654,636 |
| State | 1 / 116 | 1 / 116 |

Catch-up took 12 pages, carrying 576,312 JSON response bytes. It requires 600
change point reads plus 12 state reads for this fixture; a client pass is bounded
to ten pages, so it schedules further work. Larger entries hit the approximately
1 MB page bound earlier and may require an extra boundary read. Snapshot text is
repeated in receipts and history, so editing a fixed item set still grows storage.

Eight simultaneous independent-record writes on the mock's shared account state
produced five commits and three `account_busy` responses after bounded retries;
retrying those unchanged sequentially committed all eight. Eight different
accounts all committed. This deterministic contention check demonstrates the
retry path, **not** a deployed throughput/latency estimate.

Real request units, indexed storage, contention frequency and page latency remain
**unmeasured**. Before claiming production capacity, repeat this disposable
workload against an isolated Cosmos/SWA environment with representative small
and near-limit records and 1/2/8 concurrent clients. Record SDK `requestCharge`
for point reads/batches, batch attempts, 412/429/503 counts, response bytes,
end-to-end p50/p95/p99 latency and container/account size, with consistency,
region, indexing policy and throughput settings. Include cold-cache catch-up
from cursor zero and incremental pages. Do not infer RU from JSON bytes or mock
time. Retain the measurement report with its commit and environment.

The [opt-in Cosmos workload runner](cosmos-measurements.md) now provides a bounded
storage-only measurement step for small/near-limit records, 1/2/8 concurrent
callers, edits and catch-up. It records SDK-visible RU, batch attempts, outcomes,
payload bytes and latency percentiles. It shares one SDK client; independent
clients, authenticated HTTP latency, indexed storage and throughput observations
remain separate requirements. No real Azure result is established by its tests.

Revisit the design when measured per-account storage approaches the configured
logical-partition capacity, sustained contention causes retry exhaustion, or
RU/latency/catch-up exceeds the pilot's agreed budget. First evaluate a documented
snapshot/history-compaction protocol; merely renaming keys or changing containers
does not solve account-wide serialization. Any redesign must cover every read,
query and batch, references/moves, receipts/history/state, tombstones, fixtures,
old clients, device queues/cursors, cutover and rollback before deployment.

### Recovery before any explicit reset or migration

Completed non-Personal workspace erasures are durable restore inputs. Before serving
a restored target, reapply every protected erasure plan and verify it as described in
[workspace erasure](workspace-erasure.md). Never let a restored pre-erasure snapshot
accept ordinary traffic first.

1. Pause writes and preserve a consistent server backup including records,
   tombstones, receipts, change rows and state. Record the high-water sequence.
   Export **each device's** account-bound cache, cursor, draft and pending queue;
   server backups cannot contain unsent device work. Keep exports private.
2. Investigate `cursor_ahead` (often a restored/reset database) or `history_gap`.
   Check region/consistency and restore the matching full history where possible.
   Never delete receipts/change rows, lower cursors or clear IndexedDB as a fix.
3. Rehearse recovery in disposable storage. Reconcile immutable pending intents
   against receipts; retry identical committed operations safely. Review missing
   history/deletions/conflicts explicitly. The device export is a recovery record,
   not an automatic importer, and current v1 has no automatic reset/rebase protocol.
4. If a fresh start is deliberately approved after preservation/reconciliation,
   retire or quarantine **all** old clients/queues/cursors before activating it.
   Otherwise old queues may recreate work and old cursors may exceed new history.
   Preserve stable identity and pending work through a designed migration; do not
   silently assign a new account or discard new v1 captures.
5. Prefer a compatible roll-forward fix. A rollback needs the matching server
   backup plus reconciliation of post-backup writes and device queues; restoring
   an older application/database alone can lose work. Verify two-account isolation,
   cursor continuity and lost-response retry in the rehearsal before cutover.

## Authentication and account binding

All routes use the shared SWA authentication, exact browser-origin policy and
private/no-store headers from [Request security](request-security.md). JSON errors,
including 401/403, contain `apiVersion`, `error` and `message`. `HX-Request` is not
authentication. There is no extension CORS exception or direct backend access.

`GET /api/v1/session` returns `apiVersion`, `accountId` and built-in
`defaultSettings`. Store that account ID
with the local queue when capturing; never substitute a newly signed-in account
when uploading old work. Every operation and every data read explicitly supplies
its original `accountId`; the server compares it to the authenticated principal.
A mismatch returns 409 `account_mismatch` without storage access. A missing or
expired principal returns 401 without writing. Pause the queue, keep its drafts,
and require the original account to sign in. A missing receipt is not permission
to discard a queued operation or assign it to someone else.

## Routes and payloads

### Current persisted record shape

The first-release contract has no sparse-record compatibility mode. Every `item`,
`list`, `project`, and `review` create supplies `workspaceId`, including
`"personal"`. Every item create also supplies `collectionRefs` (an empty array for
Inbox); `listId` and `projectId` remain optional primary-membership pointers but
never reconstruct that array. Every project create supplies `status` as `active`,
`someday`, or `completed`. Clarifications, briefs, and review decisions derive
their workspace through their required parent record; workspace and settings
records are account-level exceptions.

Stored items always have a nonblank configured workflow status. Waiting items
have a nonblank `waitingOn`, deferred items have a calendar or UTC start date,
and no due/start/review date has both calendar and UTC forms. Creates and updates
validate the complete resulting shape, so an unrelated edit cannot preserve an
invalid record. The client outbox, Cosmos records, and device/account exports use
the same requirements.

| Method and route | Request | Success |
| --- | --- | --- |
| GET `v1/session` | No parameters | API version, authenticated account ID and built-in `defaultSettings` |
| POST `v1/operations` | JSON operation below | Durable committed receipt (200), or durable conflict receipt (409) |
| GET `v1/records` | `accountId`, `type=list\|item\|project\|settings\|clarification`, `id` | Current record, including its version and deletion marker; absent IDs return 404 |
| GET `v1/receipts` | `accountId`, `operationId` | Exact stored receipt (200), whose `status` may be `conflict`; absent receipts return 404 |
| GET `v1/changes` | `accountId`, `after` (default 0), `limit` (default 10, max 50) | Ordered change entries, `nextAfter`, `highWater`, `hasMore` |

Paths above are under `/api/`. See the reusable
[groceries fixture](../api/test/fixtures/v1-operations.json) for a list with three
items. Both web and future extension handoff clients can send that same contract.
Use random UUIDs (without braces) for new record and operation IDs. IDs accept
1–128 ASCII letters, digits, `_` or `-`. A record's `(accountId, type, id)` never
changes, including when its `listId` changes or becomes `null` (inbox).

```json
{
  "apiVersion": 1,
  "accountId": "account-from-session",
  "operationId": "one-uuid-per-intent",
  "mutations": [{
    "type": "item",
    "id": "stable-item-uuid",
    "action": "create",
    "expectedVersion": 0,
    "fields": {
      "title": "Milk",
      "originalText": "  milk\n",
      "workspaceId": "personal",
      "collectionRefs": [],
      "listId": null,
      "status": "inbox"
    }
  }]
}
```

Operations contain 1–20 distinct records and at most 64 KiB of UTF-8 JSON. Unknown
fields, unknown versions, malformed dates, invalid references and oversized text
are rejected rather than clipped. Lists support title (200 characters), description
(4,000) and creation-only capture fields. Items additionally support nullable
`listId`, `projectId`, calendar-date `plannedDay`, explicit `status`, nullable UTC `dueDateUtc`/`startDateUtc`/`reviewDateUtc`,
`waitingOn`, `contexts`, `areas`, `energy`, `timeRequired`, `priority` and HTTP(S)
`referenceLinks`. Tags are at most 64 characters, arrays at most 20 entries, URLs
at most 2,048 characters. Statuses allow `inbox`, `next`, `waiting`, `deferred`,
`someday`, `reference`, `completed`, `dropped`, and the destination list/account
configured values. A removed custom status must be changed before that record can
be saved again.

Creation-only fields are `originalText` (16,000 characters), `selectedText` (8,000),
`sourceTitle` (2,000) and nullable `sourceUrl`. Text retains its whitespace; omitted
`originalText` defaults to the supplied title. Updates cannot rewrite those
originals. Each resulting record must fit in 32 KiB, except bounded review metadata
using separate decision history (64 KiB; see Review sessions). A complete Cosmos batch must
fit in 1.5 MB; larger operations receive a validation error before writing. These
limits also bound stored receipts and change entries.

Projects support title, description, creation-only capture fields and a required,
nonblank `outcome` (at most 4,000 characters). Project `status` is required and
accepts `active`, `someday`, or `completed`. Updating status preserves linked actions and uses
the same expected-version conflict checks as other edits. `projectId` is an optional link to
an owned, live project; foreign, missing or deleted projects return
`404 project_not_found`. A project and its action links can commit atomically in
one operation, in either mutation order. The
[project fixture](../api/test/fixtures/v1-project.json) links the groceries fixture's
existing milk action without changing its identity, original capture, source or list.
Project deletion requires an already empty membership, just like list deletion;
otherwise it returns `409 project_not_empty`.

`plannedDay` is `null` or a real `YYYY-MM-DD` calendar date (years 0001–9999),
stored and displayed without time-zone conversion. It describes a day to work on
the action, not a deadline, start date or review cue. Assigning it never changes
`dueDateUtc`. Missing project/day fields on existing records mean unassigned;
no backfill, partition change or data reset is required. Existing action `areas`
remain optional tags and survive relationship changes. Older clients can still
edit known fields without erasing these additions. Deploy the additive API before
the new shell; do not roll back the API while project operations are pending.
See [Projects and planned days](projects.md) for the manual flow and verification.

For an edit, send `action:"update"`, the observed positive `expectedVersion`, and
only the fields to change. Completion is `{status:"completed"}` and records server-managed `statusBeforeCompletion`; reopening explicitly submits that previous status (`next` for historical records without it). Retrying cannot toggle twice. Even an edit that
sets an already-present value requires the version precondition. Send a new
operation ID for a new intent; preserve the existing ID and exact content for a
retry. Object key order is immaterial to the request hash; array order, omitted
fields, text and all supplied values are significant.

For deletion, send `action:"delete"` with an expected version and no `fields`.
The record remains as a versioned tombstone, including its text. Updates and
creates using the deleted identity return conflicts, even when a client supplies
the tombstone's latest version. Explicit `restore` of its exact version recovers
an item, list or project; there is no purge endpoint. A list must already be empty
before deletion: first acknowledge moves/deletes of its items in a separate
operation. This avoids accidental cascades and preserves account-owned references.

## Receipts, conflicts and transactions

All records in one operation, its receipt, its change entry and the account
sequence commit in one Cosmos transactional batch. There is no successful partial
list-plus-items operation. A list may be created with its items in the same request
in any mutation order. For more than 20 records, acknowledge the list/first chunk
before sending additional chunks, each with stable IDs and a distinct operation
ID. A later chunk failure leaves earlier acknowledged chunks intact; retry only
the pending chunk unchanged. There is no cross-operation transaction.

The receipt has `apiVersion`, `accountId`, `operationId`, monotonically increasing
`sequence`, `status:"committed"`, and `records` containing committed snapshots and
versions. A lost response, 503, network interruption or uncertain timeout means
**retain and retry the same operation**. The receipt is written atomically with
the records; retries return the original acknowledgement, even if later edits
have changed the records. Different content under a stored operation ID returns
409 `operation_reused`. Do not interpret an old receipt as the current record.

A version mismatch or a deleted identity without explicit restore commits **no proposed record changes**.
Instead it durably records `status:"conflict"`, an empty `records` array, the whole
operation's `proposed` mutations, and `conflicts` pairing the conflicting mutations
with current committed snapshots. Even non-conflicting edits in the rejected
transaction remain recoverable from its receipt. The
receipt/change history retains the two competing versions; earlier snapshots
remain in prior change entries. Read the latest record, show the competing text,
and submit the user's chosen resolution as a new operation with that latest
version. Retrying the conflicted operation returns the same conflict. Ordinary
validation, missing-reference and authentication errors have no durable receipt.

The account state ETag serializes decisions, including reference checks and
conflict receipts. The transaction also checks replaced record ETags. A failed
precondition causes a bounded retry of the full decision (up to five attempts);
then 503 `account_busy` tells the client to retry later with backoff. There are no
unconditional upserts. This uses the existing SDK's
[transactional batch semantics](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch)
and [per-operation conditional requests](https://learn.microsoft.com/en-us/rest/api/cosmos-db/transactional-batch).

## Bounded synchronization

`after` is an account-specific committed sequence, not a wall-clock timestamp or
row offset. Each transaction writes one contiguous change entry; conflicts also
occupy a sequence. Change entries contain the durable receipt, including snapshots
and tombstones. The client starts at 0, applies each page to its account cache,
and atomically persists `nextAfter` with those changes. Repeat pages are harmless
when applying snapshots by stable ID and version. Never advance the cursor merely
because `highWater` is larger. Newly committed work appears on later requests.

The server point-reads immutable `change:<sequence>` documents, returns at most the
requested count and approximately 1 MB of entries (plus envelope overhead), and
never advances past the last returned sequence. Reads are bounded by the requested
limit plus the state read; at a byte boundary, one read entry is left for the next
page. There are no database continuation tokens or empty query pages. Gaps return 503
`history_gap` and a cursor ahead of visible history returns 409 `cursor_ahead`.
Retain the cache/queue and investigate a restore or consistency/configuration
problem; do not reset pending work automatically. There is no history compaction
or expiration protocol yet, so change rows must not be deleted independently.

## Immutable storage identity and rollout

Keep the existing hierarchical Cosmos partition definition
`[/UserID, /ObjectType, /ObjectID]`. Every v1 document uses the immutable values
`[authenticatedAccountId, "sync", "v1"]`. Logical IDs live in `record.id`; storage
IDs are `record:list:<id>` or `record:item:<id>`. The same partition contains
`state`, `receipt:<operationId>`, and `change:<sequence>`. List membership is only a
record field. All point reads and queries supply the full account partition.

Use a single write region and at least Session consistency. Confirm the actual
container partition definition and indexing of `kind` and the nested
`record` fields in staging. State reads and subsequent validation queries share
the SDK partition session token; ETags arbitrate simultaneous writers. Do not
enable independent multi-region writers or writers that bypass this protocol.
No settings are created automatically by GET requests.

Receipts, change history and tombstones currently have no expiration; v1 documents
set `ttl:-1` to prevent a container default TTL from expiring them. Retention and
account erasure are issue #13. Account partitions serialize writes and accumulate
history, so measure storage/RU usage before pilot expansion. Replace this bounded
pilot design if account volume approaches Cosmos logical-partition limits or
contention becomes significant; do not silently prune retry receipts/tombstones.

## Current backup, restore and rollback rehearsal

For live storage protocol checks (receipt replay, conflicts, account partitions,
tombstones, paging and transactional rollback), run the
[isolated Cosmos rehearsal](cosmos-rehearsal.md). It creates a fresh temporary
database and records its results; it does not replace an Azure backup/restore
rehearsal or certify deployed authentication. Backup artifacts and device exports
contain private data; keep them outside Git with the same access controls as the
live account.

Staging/production procedure:

1. Pause v1 writes and take a consistent Azure backup of the current container.
   Record the environment, timestamp, candidate commit, container configuration,
   account counts and restore point. Export each device copy separately so unsent
   drafts and queued operations are not lost.
2. Restore the backup into an isolated target with the same hierarchical partition
   and index settings. Keep its API disabled until the restore is complete; never
   import or upsert backup data into an active v1 store.
3. Read back and compare owners, current records, tombstones, receipts, change rows,
   state sequences and stored fields. If restore is interrupted, discard/recreate
   the isolated target and restore again. Partial restores must never serve requests.
4. Enable the matching v1 API only in that isolated environment. Exercise lost
   acknowledgements, concurrent edits/reference races, bounded pages and a stale
   edit after deletion against **real Cosmos** with two authenticated accounts.
   Inspect actual API headers and RU/latency. Verify the durable inbox from #5
   before choosing a production restore or cutover.
5. Rehearse application rollback with a known compatible API/client pair while
   writes remain frozen. Preserve all newer v1 records, history, receipts and device
   queues before changing deployments. An older database backup alone loses newer
   work; reconcile it explicitly rather than claiming an automatic lossless rollback.

## Evidence and remaining gates

Run `npm test` from `api/` with Node 22.x and Playwright Chromium. Coverage includes
registered production HTTP handlers with a transactional in-memory Cosmos
substitute, rollback injection at every batch position, lost acknowledgements,
simultaneous duplicate writes/edits and membership/deletion races, immutable moves,
tombstones, paging bounded by both entry count and bytes,
account switching/expiry, malformed input and the native desktop/390px browser flow.

These checks do not certify actual Cosmos transaction responses, consistency,
partition/index configuration, Azure backup restoration, deployed authentication,
or a production client cutover. Keep #4 open until the real staging restore,
rollback and data API evidence is recorded, alongside #3/#17 deployment gates.

## Additive defaults contract (issue #25)

A singleton record has type `settings`, id `settings`, and fields
`{defaults:{contexts:[],areas:[],energy:[],timeRequired:[],priority:[],statuses:[]}}`.
Create at expectedVersion 0; subsequently update at the observed version. Deletion
is rejected; reset is a normal update containing the chosen built-in snapshot.
Every array is required, bounded to 200 options, deduplicated, and each value is
validated as a single line of at most 64 characters. Lists accept the same optional
`defaults` field. Copy/reset is resolved on the client when selected, reviewed in
the form and saved explicitly; retries cannot recalculate against newer defaults.

Settings use the same account partition, receipts, change entries, expected versions
and conflicts as items. Older inbox clients ignore unfamiliar settings records and
continue to handle task records; do not downgrade the server after settings writes.
Built-in defaults are the base; the current versioned settings record overrides
them when present. Lists without an override inherit those effective user defaults.

No IndexedDB schema change or record rewrite is required. The session's built-in
options are cached inside the existing account document for offline editing. The
first settings save becomes an ordinary change-feed record. Existing pending
operation IDs and content remain unchanged.

## Review sessions

`review` records reference up to 200 canonical item/project IDs and hold a
daily/weekly scope plus bounded pointers to immutable `reviewDecision` records;
inline decision arrays are not part of the contract. Continuation batches link
through `previousReviewId`. A decision, its review pointer and canonical task
edit share one version-checked operation; retries do not duplicate decisions, and
conflicts apply none of the edits. The server validates exact prior/next states and guards undo
against subsequent edits. `dropped` is a retained, editable item status, not a
tombstone. See [review behavior, contract and recovery limits](reviews.md).

## Read-only account export

`GET /api/v1/export?accountId=...&after=0&limit=50` returns an ordinary bounded
change page. Capture `highWater` from the first page and supply it as `through` on
every continuation, with `after=nextAfter`.
`after > 0` requires `through`; both are safe non-negative integers and `limit`
is 1–50. The returned `highWater` stays at that cutoff and `hasMore` indicates
remaining entries through it, even when new writes advance the account state.
An empty account or `through=0` returns an empty snapshot. Every page requires
the authenticated account match and inherits private/no-store API headers.

Replay committed entries in sequence, replacing snapshots by type/id; conflict
entries advance the cursor without applying proposals. Never omit tombstones.
The existing immutable history and account partition provide the snapshot, with
no new documents, writes or sync protocol changes. A cutoff beyond visible
history returns `409 snapshot_unavailable`, an `after` beyond the cutoff returns
`409 cursor_ahead`, and a missing intermediate entry returns `503 history_gap`.
Do not publish a partial export on any error. A reset/restored database must not
reuse history sequences with different contents; the backup/restore restrictions
above apply. Real Cosmos consistency remains a deployment gate.

See [export formats, browser bounds and recovery limits](device-export.md).
