# Durable inbox (issue #5)

`/` is the native v1 client; `/inbox.html` is a bookmark alias. It uses native JavaScript,
IndexedDB, Web Locks and a small service worker; it has no build step or new
dependency. It requires HTTPS (or localhost), a supported modern browser and a
successful first sign-in while online. Installation as a PWA, update prompts and
physical-device certification remain #14/#17 work.

## Capture and editing

- Enter a title and save directly to the inbox without classifying it. Each
  non-empty newline becomes one item, in input order, with surrounding title
  whitespace removed. The exact original input is retained separately.
- For groceries, enter `milk`, `bread`, `eggs` on separate lines, expand the
  options and enter `Groceries` as the new list. One save creates the list and
  all three items atomically. Each item retains the original capture, even after
  its title, notes or list changes.
- Commas and semicolons do not split automatically. The optional preview button
  converts them to editable lines; **Save on device** confirms those lines. It
  does not attempt to infer sentence meaning. The pre-preview text is preserved.
- A save accepts up to 20 items, or 19 with a new list, within the API's 64 KiB
  operation limit. Larger input stays in the form with a visible error. Titles
  are limited to 200 characters, notes to 4,000 and original capture to 16,000.
- Edit titles/notes, move items between existing lists or back to the inbox,
  complete, and reopen offline. Reopen restores `statusBeforeCompletion`; older
  completed records without a prior status use `next`. List titles and
  notes are editable. New list creates an empty list with title/notes. Optional task
  details expose status, due date/time, contexts, areas, energy, time and priority;
  Your work filters the local cache by destination and status. Projects and AI are not prerequisites.
- Quick capture focuses the text box; Ctrl/Command + Enter saves. The submit
  guard prevents concurrent submissions, preserves input entered during a local
  save, and restores capture focus. The action follows the textarea in normal
  page flow so a small keyboard viewport can scroll without covering the input.

## Local persistence and retry

The `todo-inbox-v1` IndexedDB database keeps independent account documents. A
strict-durability transaction commits the immutable operation and draft update
together. Only transaction completion displays **Saved on device**. A successful
individual IndexedDB request is insufficient: the transaction can still abort.
The account's last capture/edit draft is journaled on input. The draft slot is
shared between tabs; save a draft as an item before composing another unsaved
draft in a second tab. Submitted saves from multiple tabs are transactionally
serialized and do not replace each other.

The outbox stops accepting new saves at 100 operations or 5 MiB. Full-queue, quota
and transaction failures keep the form text and expose a selectable recovery copy.
**Export device copy** downloads JSON containing the account's server snapshots,
pending operations, cursor and current draft. It is a recovery record, not a
complete server export or an automatic import tool (#13). Keep it private.

Records display **Saved on device — pending**, **Server-confirmed**, or
**Failed — needs attention**. Online foreground activity, reconnect and **Sync now**
check the session, apply at most ten bounded change pages, and submit at most
100 queued operations per pass. Remaining work schedules another foreground pass.
Network/server failures retain the exact operation IDs and content and retry
with 2–60 second backoff and a 15 second request timeout. No background sync or
hidden-tab polling is required. Web Locks serialize synchronization across tabs;
IndexedDB transactions serialize enqueues, acknowledgements and cursor advances.

The client applies snapshots only when their versions are newer. A change-feed
receipt can acknowledge a save whose HTTP response was lost. The receipt and
cache update remove the operation in the same local transaction; interruption
before commit simply retries it. Predicted versions chain local edits to pending
creates/edits without rewriting an operation that might already have been sent.

Conflicts stop the queue and show the pending and server text. The user can
explicitly apply an edit against the reviewed server version or discard that
failed save. Resolving uses a new operation ID; another concurrent edit conflicts
again. A deleted/missing record cannot be overwritten. Later queued edits remain
recoverable and may need separate review; nothing silently rebases them. Server
validation failures also stay visible until explicitly removed. Uncertain network
outcomes never offer a discard button.

## Account and offline boundaries

The initial online session is verified before displaying a cache. Every queued
operation permanently carries its original account ID, and every server data
read supplies that ID. A different signed-in account opens its own cache/draft;
the old queue remains untouched. Expiry, account mismatch and sign-out hide the
workspace and pause offline reopening until a successful sign-in. Reconnect as
the original account to recover and synchronize its pending work.

Offline launch can only know the last verified active account. It never infers a
new account or adopts a queue into one. An account change in another inbox tab
hides the old workspace through BroadcastChannel; foreground activity rechecks
the server. Local copies are not encrypted or a security boundary against another
person using the same browser profile or devtools. Use separate profiles on shared
devices. Explicit site-storage clearing, browser eviction or device loss can
destroy unsynced work; the UI explains this and offers an export.

## Canonical shell and updates

The worker caches only the public root/index/bookmark shell, local CSS, theme
script and native modules, never API/auth responses or task data. Wait for
**Ready to reopen this inbox offline** before relying on offline reload. Both
root and the inbox alias work offline once worker v4 is active.

Module URLs carry `?v=4`; the previous v3 worker ignores query URLs, preventing a
new shell from importing old cached modules. A worker-version handshake reports
readiness only when the matching worker is active. A waiting worker is not forcibly
activated: save work locally, close every app tab/window, then reopen online. Old
shell caches are retained so old clients keep their assets. Cache installation
failure leaves the old worker/cache usable at its original inbox URL; it does not
clear IndexedDB. Full update prompts, cache-retirement UX and PWA installation are
still #14. Update the shell/module version together when changing cached modules.

## Defaults and compatibility

User/list defaults are versioned records in the same outbox as tasks. Reset/copy
loads a snapshot into the defaults editor and Save explicitly commits that snapshot
on device. Drafts survive closing and reload. Custom statuses are validated against
effective options, while existing/prior statuses are preserved. New lists copy user
defaults; lists without defaults inherit user/built-in options. Changing options
does not overwrite text or selected values in an open capture/editor.

The existing `todo-inbox-v1` database and account object store are retained unchanged.
Built-in and archived defaults are additive metadata inside the account document;
old queues, operation IDs, snapshots, cursors and drafts are not reset or rewritten.
An older offline profile without option metadata must reconnect once before editing
defaults. Settings records use the new `settings:settings` logical identity.

## Release and recovery checklist

1. Keep deployment and Cosmos settings unchanged during PR review. On the target
   environment confirm `V1_API_ENABLED=true`, exact `APP_ORIGIN` and the existing
   Cosmos connection, hierarchical partition paths and Session consistency/single
   write region. `V1_CLIENT_ENABLED` is obsolete and ignored by this release.
2. The owner emptied the legacy database and has opened the new UI. No legacy import
   is required for that cutover. Preserve any new v1 server records and device data.
   Retain the old migration tool/checksum fixtures for other archived datasets.
3. Deploy the additive API and native shell together. Test root, inbox bookmark and
   GitHub auth return. Legacy POSTs must return 409 for legitimate authenticated
   requests; old GETs return 410. The shared guard blocks non-v1 writes even with
   the old client flag false/unset. A disabled API shows an error, never old data.
4. Verify task/default saves, offline reopen/reconnect and two-account isolation in
   disposable Azure staging, then two real devices. Check custom values, previous
   status, API headers and exact retry outcomes against real Cosmos.
5. Test an existing browser profile: preserve/export a draft and pending operation,
   upgrade the worker with old tabs present, close/reopen, sync once and compare IDs,
   text and cursor. Never clear site storage merely to make the upgrade pass.
6. Before reverting an application deployment, stop new writes and preserve v1
   records/history/receipts plus each device's pending export. Prefer rolling forward
   to a compatible fix. An old server cannot accept the new settings contract; an
   old backup alone loses newer work. Reconciliation is required before a downgrade.

A database reset does not reset browser cursors or queues. `cursor_ahead`/`history_gap`
require recovery/investigation; do not automatically reset pending work. Explicit
storage clearing is a deliberate fresh start only after exports and user confirmation.

## Verification and remaining gates

See the [issue #25 verification report](design/vanilla.md) for the 37-test local
result, upgrade checks, responsive screenshots and outstanding release gates.

Run `npm test` in `api/` (Node 24+ for module-mocking tests). Use
`PLAYWRIGHT_CHANNEL=msedge` on a machine with Edge, or install Playwright Chromium
as in CI. The native parity, security, transaction and migration checks are described in [Task flow](task-flow.md).

The new browser checks exercise real IndexedDB, service workers and the production
v1 HTTP handlers, backed by the existing transactional in-memory Cosmos substitute:

- Atomic groceries capture; offline title/body/list edits, list rename,
  completion/reopening; originals and stable identity after reconnect.
- Offline reload plus closing and restarting a persistent browser profile;
  both submitted work and the last unsubmitted draft survive.
- Lost HTTP acknowledgement, retry/change-feed confirmation, and no duplicate.
- Account A/B switching, expiry, paused offline restart, and original-account
  recovery without displaying or uploading the other account's work.
- Conflicting text, explicit resolution, stale edit after deletion, server
  rejection, copy/export recovery, queue bounds, quota and transaction abort.
- Editable split preview, competing-tab saves, duplicate submit guard,
  keyboard shortcut/focus, 390px width and a shortened keyboard viewport.
- Canonical root/bookmark, all flag combinations and unconditional rejection of every retired mutation.
- Defaults/copy/reset, custom states, advanced task fields, previous-status restore,
  persisted settings drafts, old-worker upgrade and exact pending intent retention.

Local verification uses Edge 154 and Node 26.7 on Windows. These are browser
automation checks, not physical Android/iPhone keyboard or OS-eviction evidence.
Azure auth/Cosmos behavior, staging migration/rollback, real storage exhaustion,
screen readers and physical phone/desktop checks remain unverified release gates
in #3/#4/#5/#14/#16/#17. Keep #5 open until its real-device evidence is recorded.
