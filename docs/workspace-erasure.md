# Operator-assisted workspace erasure (#189)

This procedure permanently removes one named, non-Personal v1 workspace from one
account while retaining the account's other workspaces. It is an operator action,
not the recoverable **Delete** control and not whole-account erasure. Shared lists
have a separate ownership model and are outside this procedure.

## Plan, approve and apply

Pause ordinary support changes for the target account and record the deployed
commit, environment, operator, actual Cosmos backup policy, and the last time a
pre-erasure backup can expire. From `api/` on Node 22, set the connection, database
and container settings for the explicitly approved target without putting secrets
in command arguments or evidence.

```text
npm run erase:workspace -- plan --account <exact-account-id> --workspace <exact-workspace-id> --out <new-plan.json>
npm run erase:workspace -- apply --plan <plan.json> --confirm <erasure-id-from-plan>
```

The plan is an exclusive-create file. It contains the explicit account/workspace,
aggregate counts and bytes, hashed record identities, a storage fingerprint and a
random erasure ID. It contains no task text, titles, raw record IDs, operation IDs,
receipts or conflict bodies. Review its target and counts before applying it.
`personal` is always refused; use the whole-account procedure tracked by #144.

Apply first creates a non-expiring `workspace-erasure:<workspaceId>` fence and a
contiguous change signal in the account partition. The fence is serialized through
the account state ETag, so an older in-flight writer retries and observes it. The
workflow then deletes scoped current records, tombstones and derived rows, removes
applicable receipts, and rewrites affected history rows in place without renumbering
the change feed. Mixed history retains unrelated records. The final fence contains
only the target identity, erasure ID, state, timestamps and completed sequence.

An interrupted run leaves the fence active. Re-run the exact plan and erasure ID;
completed phases are harmless and a completed run is a verified no-op. Never create
a replacement plan after fencing, remove the fence, or split/rebase rejected offline
operations. A different erasure ID is refused.

## Scope and ownership

Scope is decided at the fence snapshot. Items, lists, projects and reviews currently
in the workspace are removed. Clarification follows its item, review decisions follow
their review, and briefs follow their subject. History follows the current identity:
a record moved out before the fence is retained with its derived history; a record
moved in is erased with its derived history. Settings, Personal, other workspaces,
other accounts and shared-list partitions are not selected.

Updated clients process the `erasedWorkspaces` change before sending their queue.
They remove the workspace's cached records, drafts, mixed target operations, undo and
move plan while retaining unrelated workspaces/accounts. A mixed pending operation is
discarded as one intent; recreate any unrelated unsynced portion deliberately. An old
or offline device can retain bytes until it upgrades and syncs or its site data is
cleared, but the server fence rejects its stale queue.

## Backups and copies the service cannot recall

The repository neither configures nor discovers the deployed Cosmos backup-retention
duration. Record the real Azure policy and expiry in the support erasure record.
Immutable backups can contain the old bytes until expiry and cannot be selectively
edited. Protect the completed plan outside the restored data plane for at least that
duration.

Never enable a restored database directly. Keep the restored target unavailable,
create a plan for its restored snapshot using the retained erasure ID, apply and
verify every applicable erasure, then enable ordinary traffic. If neither the live
fence nor protected operator record survives, this code cannot truthfully guarantee
that an older backup will not resurrect data.

Downloaded device/server exports, copied files, screenshots, recipients' copies and
offline/unupgraded devices cannot be remotely recalled. Owners and operators must
delete copies they control. Record that limitation in the user-facing outcome rather
than claiming immediate removal from every backup or device.

## Verification and evidence

Run the focused test and the complete suite. The local harness covers two accounts,
multiple workspaces, mixed history, stale writes, interruption/resume, idempotency and
device cleanup; it is not deployed evidence.

```text
node --experimental-test-module-mocks --test test/workspace-erasure.test.mjs
npm test
```

For a real Cosmos storage rehearsal, use a disposable single-write-region account:

```text
npm run test:workspace-erasure:cosmos -- --isolated-account <new-report.jsonl>
```

Set `WORKSPACE_ERASURE_REHEARSAL_CONNECTION_STRING` through the normal secret
mechanism. The runner creates a new database with live/restored containers, seeds
synthetic A/B accounts, interrupts and resumes erasure, logically restores the
pre-erasure rows into the disabled second container, reapplies the retained decision,
verifies isolation, and deletes the database. Its append-only evidence records commit,
dirty state, Node/SDK versions, generated environment IDs, aggregate expected/actual
counts, PASS/FAIL phases, restore guard and cleanup—never credentials or fixture text.
This is a logical restore rehearsal, not proof of Azure-managed backup restoration;
the latter remains a release gate.
