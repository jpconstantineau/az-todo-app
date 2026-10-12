# Operator-assisted whole-account erasure (#144)

Whole-account erasure permanently makes one authenticated storage identity
unavailable. It is distinct from recoverable Delete, restore, export, clearing one
device, and [named-workspace erasure](workspace-erasure.md). The pilot has no
self-service destructive control: an operator starts only from a verified request
whose authenticated principal exactly equals the account ID used by storage.

## Explain the result before approval

The requester must be told that the procedure removes the server data described
below and that an updated browser removes this account's device profile the next
time it reconnects. An offline or unupdated device can retain its last local bytes
until it reconnects or its site data is cleared. Immutable backups can retain bytes
until the observed deployed retention policy expires. Exports, screenshots, copied
files and copies already downloaded by collaborators cannot be remotely recalled.

For shared lists, lists owned by the erased account are deleted in full because the
service has no ownership transfer. On another owner's list, the account's member
name, grant and operation receipts are removed. Existing collaborative items remain:
the current schema cannot reliably attribute every item or field, and guessing
would delete another person's shared work. State that limit in the outcome.

## Plan, approve and apply

Pause support changes for the target. Record the clean deployed commit, isolated
environment, operator, verified request evidence, actual Cosmos backup mode and the
last UTC time at which a pre-erasure backup can expire. From `api/` on Node 22, pass
secrets only through the normal environment settings:

```text
npm run erase:account -- plan --account <exact-id> --verified-principal <same-exact-id> --backup-expires-after <utc> --out <new-plan.json>
npm run erase:account -- apply --plan <plan.json> --confirm <erasure-id-from-plan>
```

The plan file is exclusive-create. It contains the exact target and verified
principal, random erasure ID, planned state ETag/sequence, backup-expiry obligation,
aggregate counts/bytes, a storage fingerprint and hashed candidate identities. It
does not contain task/list text, raw record/list IDs, invitation material, operation
bodies or credentials. A changed live candidate is refused before fencing. Review
the target, backup observation and aggregates separately, then explicitly approve
the generated erasure ID.

Apply first creates the non-expiring `account-erasure` fence in the private account
partition while serialized against its state ETag. Every v1 route—including
session, reads, receipts, changes, export and writes—and every shared-list route
then returns stable `410 account_erased`. No rejected replay creates a state,
receipt or record. Apply removes all other private partition documents, including
Personal and named-workspace records, settings, current/deleted records, derived
history, receipts, changes and older workspace-erasure markers. It deletes every
owned shared-list partition and removes membership/name plus that actor's receipts
from lists owned by others. Shared cleanup rescans after the fence to a verified
fixed point.

Shared writes reserve a text-free marker in the same private account partition
before committing their separate list-partition batch. Fence creation reserves the
same marker atomically, so an in-flight shared write either finishes before the
plan can be applied or loses to the fence and cannot write. If a save is still
active, wait for its exact retry to finish/release the marker and create a new dry
run; do not bypass or delete the marker manually.

An interruption leaves the fence active. Re-run the exact plan and erasure ID;
completed phases and aggregate accounting are repeat-safe, including shared-list
partitions larger than one batch. A different decision is refused. The final fence
is the sanitized outcome: exact target, erasure ID, timestamps, expected/actual
aggregates, shared dispositions, backup-expiry obligation and status. It contains no
user content.

## Devices and stale work

Updated clients verify the session before either private or shared outbox work. On
the first matching `account_erased` response, one IndexedDB transaction deletes only
that account profile—records, drafts, queues, failures, undo/editor/workspace state,
account preferences, shared caches/drafts/pending action—and pauses the cloud
session. Other cloud profiles and the device-only profile remain. The route is
replaced with Capture and focus moves to its heading; browser history cannot recover
the removed profile. An offline client may display its saved copy, but reconnecting
runs the barrier before submission and then performs this cleanup.

Older clients do not understand the cleanup outcome, but the permanent server fence
still rejects their creates, updates, deletes, restores, invitation joins, shared
writes and receipt replays. Clear site data on an offline device that will never be
updated or reconnected.

## Backups, restore and evidence

Keep the approved plan/outcome outside the restored data plane for at least the
measured backup lifetime. Never serve a restored target directly. Keep it disabled,
reconcile post-backup work for non-erased accounts, then reapply each retained
decision with the same plan and erasure ID:

```text
ACCOUNT_ERASURE_RESTORE_TARGET_DISABLED=true npm run erase:account -- apply --plan <protected-plan.json> --confirm <erasure-id> --restore-replay --confirm-disabled-target <COSMOS_CONTAINER>
```

`--restore-replay` is only for a disabled restore target: it accepts changed restored
storage under the already approved identity/decision, reinstalls the fence, removes
all target data and shared references, and verifies the fixed point. It must not be
used to bypass a changed live dry run. The CLI requires both an explicit disabled-
target environment guard and the exact configured container ID. Enable traffic only after the erased account
is fenced/absent, shared references are absent, and non-erased post-backup work is
verified.

Local verification:

```text
node --experimental-test-module-mocks --test test/account-erasure.test.mjs test/shared-lists.test.mjs test/account-sync.test.mjs
npm test
```

Disposable Cosmos rehearsal:

```text
ACCOUNT_ERASURE_REHEARSAL_CONNECTION_STRING=<secret>
ACCOUNT_ERASURE_BACKUP_EXPIRES_AFTER_UTC=<observed-policy-expiry>
npm run test:account-erasure:cosmos -- --isolated-account <new-report.jsonl>
```

The runner creates new live and disabled-restore containers, uses disposable A/B
identities, records the exact candidate commit/dirty state, environment IDs,
Node/SDK versions, expected/actual aggregate counts, phase PASS/FAIL, backup-policy
observation and cleanup, and appends checkpoints without fixture text or secrets. It
interrupts/resumes live erasure and reapplies the decision to a logical pre-erasure
restore while preserving B's post-backup work. This is not proof of an Azure-managed
backup restore; the real disabled-target restore and production go/no-go remain #17.

This procedure does not delete the external authentication-provider identity,
cancel billing, transfer shared-list ownership, delete unattributed collaborative
content, recall downloads/offline devices, selectively edit immutable backups, or
authorize a production purge during implementation.
