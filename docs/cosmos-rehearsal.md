# Isolated Cosmos protocol rehearsal (#4)

`npm run test:cosmos` runs the production v1 storage service against real Azure
Cosmos DB. It is opt-in and is **not** part of `npm test` or CI. The ordinary test
suite runs the same scenarios with the existing in-memory storage substitute and
tests the runner's resource lifecycle and failure reporting. Those local results
do not count as a real Cosmos pass.

For the separate opt-in RU/latency/contention workload, add `--measure` before
`--isolated-account`; see [workload measurements and evidence limits](cosmos-measurements.md).
Both modes use the same isolated target lifecycle. Run them separately.

## Target and invocation

Use a **disposable Cosmos DB for NoSQL account**, with exactly one write region,
multi-region writes disabled, and Session, Bounded Staleness or Strong consistency.
The tool checks those account properties before creating anything. Do not supply
production credentials. The credential needs account metadata access and permission
to create/delete databases and containers, and read/write items. This consumes
Azure resources and may incur charges, including provisioned container throughput.

The tool creates a unique `az-todo-rehearsal-<UUID>` database and one `protocol`
container, with the application's hierarchical partition key
`[/UserID, /ObjectType, /ObjectID]` and an explicit consistent all-path index.
It never selects an existing database, uses `createIfNotExists`, reads production
records, or changes the account's settings. `COSMOS_DB`, `COSMOS_CONTAINER`, and
the application's `CosmosDbConnectionSetting` are not inputs to this runner.

From `api/`, on Node 22.x after `npm ci`:

```text
npm run test:cosmos -- --isolated-account <new-report.jsonl>
```

Before invoking, set `COSMOS_REHEARSAL_CONNECTION_STRING` in the process environment
using your usual secret mechanism. Do not put it in command arguments, source
control, the report, or pasted logs. `--isolated-account` explicitly acknowledges
that this is a disposable target. The report must be a new writable file; an
existing file is never overwritten. Prefer a report path outside the checkout so
the report itself does not mark the candidate working tree dirty.

## What is checked

- A list plus milk/bread/eggs commits atomically. Discarding its acknowledgement
  and concurrently replaying the same intent returns the same receipt/sequence;
  changed-content operation-ID reuse fails without another write.
- Competing edits based on one version produce a winner and a durable conflict.
  Both proposals remain available, a mixed stale batch cannot partially update
  its other item, and explicit resolution uses a new intent/current version.
  Replaying completion cannot toggle the item back.
- Independent edits within one account both commit. Guessed record/receipt IDs
  and foreign list references cannot cross account partitions. Separate accounts
  can use the same logical IDs without overwriting each other.
- Deletion leaves a tombstone. Stale edits, recreating the ID and even an edit at
  the tombstone's current version conflict without resurrection.
- Two-entry change pages remain contiguous while another capture arrives;
  conflicts and deletions appear, a fixed export cutoff remains fixed, and a
  cursor beyond current history fails rather than resetting.
- A seven-write SDK batch deliberately attempts a duplicate create at each
  position in turn. Cosmos must report the conflict and failed dependencies, and
  no other new document may persist. A subsequent production capture/retry still
  commits exactly once. This checks the service's transaction rollback, using
  the [documented Cosmos batch behavior](https://learn.microsoft.com/en-us/azure/cosmos-db/transactional-batch).

## Evidence and cleanup

The JSON Lines report records the Git commit/dirty state, Node and locked SDK versions, UTC
timestamps, generated target IDs, observed consistency/regions/partition/index
configuration, scenario outcomes and elapsed times, and cleanup outcome. Use a
clean checkout and the locked dependencies for release evidence. Add the isolated
account/environment identity and operator to the release record separately.
Only allowlisted error codes are recorded; SDK exception messages, headers,
connection strings, raw task contents and account principals are excluded.

Each line is a complete snapshot; the last complete line is the latest result.
Snapshots are appended and flushed before database creation and each scenario,
so interruption cannot erase an earlier recorded target ID. Ignore any incomplete
final line after a forced interruption. Cleanup
deletes only the database returned by this invocation's successful create, even
when a scenario or container creation fails. Failed checks or failed cleanup
produce a nonzero exit status. A normal successful run ends with `status: PASS`
and `cleanup: deleted`.

A killed process, lost create acknowledgement or failed delete can leave the
temporary database behind. `creation_pending`, `pending`, or `failed` cleanup
requires inspecting the **exact generated database ID in that report** in the
disposable account and removing it if it belongs to this run. The tool deliberately
does not retry a creation or delete a database whose creation it did not acknowledge.
Retain failed reports and use a different output path for each rerun.

## Evidence limits

This exercises storage code directly with synthetic account IDs. It does not
authenticate two real SWA users, prove the trusted ingress boundary, exercise
browser queues, simulate a network outage, or measure a deployed API. Dropping an
acknowledgement means discarding a completed result in the runner. Batch rollback
uses a real duplicate conflict, not an injected infrastructure outage. Concurrent
operations use one production SDK client; they do not establish cross-region or
independent-client session consistency. Scenario elapsed times are diagnostics,
not representative latency/RU/capacity measurements for #27.

The new container's index policy is recorded; this does not inspect or certify the
deployed container's configuration. Legacy migration, Azure backup restoration,
post-backup writes, device-queue recovery, and rollback remain separate checks in
[the data API procedure](data-api-v1.md#migration-and-rollback-rehearsal).
Keep #4/#17 open until those gates and actual isolated Cosmos evidence pass.
No live Cosmos run is claimed by adding this tool.
