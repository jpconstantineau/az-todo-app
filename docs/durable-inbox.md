# Durable inbox (issue #5)

`/` is the native v1 client; `/inbox.html` is a bookmark alias. It uses native JavaScript,
IndexedDB, Web Locks and a small service worker; it has no build step or new
dependency. It requires HTTPS (or localhost), a supported modern browser and a
successful first sign-in while online. Installation as a PWA, update prompts and
physical-device certification remain #14/#17 work.

## Using the same account on phone and laptop

Yes: independent browser profiles/devices signed into the same **SWA account**
can use the same API/database. Each has its own IndexedDB records, capture/editor
draft, outbox and change cursor. Different accounts remain isolated; this is not
shared-list collaboration between users. Same-browser tabs share one account
database and one unsaved draft slot: save the draft before composing another in
a second tab. Web Locks and BroadcastChannel coordinate those tabs only.

The account label uses `clientPrincipal.userDetails` from a same-origin, no-store
`/.auth/me` request after v1 session verification. Its `userId` must match the
verified `accountId`. The name is rendered as text and never replaces the stable
ownership/storage ID. Requests from an earlier account/session are ignored, and
each successful online session refreshes the name (including a renamed handle).
Missing, malformed, failed or timed-out profiles show **Your device inbox** and
do not delay capture or sync. Names/auth payloads are not persisted or cached;
offline reopen uses the neutral label. Logout/expiry/account switch clear the name
alongside the existing account isolation flow. A profile lookup is display metadata,
not a second authentication authority. See Microsoft's
[SWA principal fields](https://learn.microsoft.com/en-us/azure/static-web-apps/user-information).

```mermaid
sequenceDiagram
    participant P as Phone
    participant D as Phone IndexedDB
    participant A as v1 API / account partition
    participant L as Laptop
    P->>D: Save draft + immutable operation in one transaction
    D-->>P: Transaction complete: Saved on device
    P->>A: Verify session; pull changes after saved cursor
    P->>D: Apply page and advance cursor atomically
    P->>A: Submit operation ID + expected record versions
    A->>A: Commit records + state + receipt + change together
    A-->>P: Durable receipt (or conflict)
    P->>D: Apply receipt; remove acknowledged queue entry
    L->>A: Next foreground sync: verify session, pull changes
    A-->>L: Ordered committed snapshots/receipts
    L->>L: Apply newer versions and persist cursor together
```

Sync runs at startup, after saves, reconnect, focus/visibility return, **Sync now**,
and scheduled retries/remaining work. There is no continuous server push or idle
polling. An already-visible idle laptop may need **Sync now** to see a phone's edit.
Each pass pulls up to ten pages of at most 50 changes and sends up to 100 queued
operations; remaining work schedules another pass. Requests time out after 15
seconds, with 2–60 second retry backoff. No background-sync guarantee is made.
First-ever sign-in requires online verification; an already initialized account
can capture offline unless its session has been paused by logout or expiry.

### When edits collide

Suppose both devices have “Milk” at version 3. The phone edits it to “Oat milk”
and commits version 4. The offline laptop proposes “Two cartons of milk” against
version 3. On reconnect the laptop pulls version 4, but keeps its original queued
intent unchanged. Its submission receives a durable conflict: none of that
operation's proposed record changes apply. The UI retains the laptop text and
shows the server version. Choose the server version, or explicitly apply the
reviewed edit as a **new operation** against version 4. Another intervening edit
will conflict again. Even edits to different fields of one record conflict;
there is no automatic field merge or last-writer-wins overwrite.

The failed queue head blocks later saves, which stay on device. Resolving one
save does not silently rebase later queued edits; they may need their own review.
A deleted record cannot be resurrected by a stale edit. Independent record edits
can both succeed, but all writes within one account compete for the account-state
ETag; after five unsuccessful concurrency attempts the API returns `503 account_busy`.
Retry the same intent later. Separate accounts have separate transaction boundaries.

If the phone's create commits but its HTTP acknowledgement is lost, retrying
the exact operation ID/content returns the original receipt; a pulled change
receipt can also acknowledge it. There is still one item. Reusing the ID with
different content fails with `409 operation_reused`. In contrast, independently
saving “Milk” on both devices creates two distinct operations/record IDs and two
items: retry protection is not text deduplication.

The application's `change:<sequence>` documents are an ordered history, not
Cosmos's native change feed. Receipts and history currently grow without
compaction/expiration. Deleting them breaks retry/cursor guarantees. Partition
semantics, inspection queries, measured fixture sizes and recovery steps are in
the [v1 protocol decision](data-api-v1.md#partition-decision-issue-27).

### Issue #27 verification

Run from `api/` on Node 24+ with installed Playwright Chromium, or set
`PLAYWRIGHT_CHANNEL=msedge`: `npm test`. New `account-sync.test.mjs` checks
matching/renamed/untrusted profile names, malformed/null/mismatched profiles,
HTTP failure, timeout, delayed account-A responses after switching to B, logout, expiry,
offline reopening and absence of API/auth shell caches. Two **independent browser
contexts** check A-create/B-pull, independent edits, offline same-record conflict,
queue blocking, explicit resolution and distinct equal-text captures. A separate
same-profile-tab check proves the shared draft limitation. Existing
`inbox.test.mjs` checks competing tabs, lost responses, paused sessions,
stale deleted-record edits and recovery; `v1.test.mjs` checks changed-content ID
reuse, atomic conflicts and isolation. These use production handlers and an
in-memory transactional storage substitute, not live SWA/Cosmos.

Local evidence: October 2, 2026 (America/Regina), Windows, Node 26.7.0,
Playwright Chromium 153.0.8010.12; exact tested commit and suite result are
recorded in the PR. Expected results are the assertions above; actual local
results must pass before merge. Real Android/iPhone/desktop session and Cosmos
RU/latency evidence remain **unverified**, so #27 remains open for those gates.
For deployed verification, record commit, disposable environment, OS/browser,
steps and expected/actual results for each scenario above, using real SWA auth,
two independent clients plus two accounts, a single write region and at least
Session consistency. Do not treat the local mock's concurrency timing as Cosmos
performance or as proof of the production authentication boundary.

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
root and the inbox alias work offline once worker v6 is active.

Module URLs carry `?v=6`; the v3 worker ignores query URLs and the v4/v5 workers'
exact allowlists exclude these new URLs, preventing a new shell from importing
old cached modules. A worker-version handshake reports
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
