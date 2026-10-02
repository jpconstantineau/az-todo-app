# Durable inbox (issue #5)

`/inbox.html` is the v1 capture and editing client. It uses native JavaScript,
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
  complete, and reopen offline. Reopen explicitly sets `inbox`; richer workflow
  transitions and their previous-state semantics belong to #8. List titles and
  notes are editable. Projects and AI are not prerequisites.
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

The worker caches only `/inbox.html`, `/inbox.css`, `/inbox.js` and
`/inbox-store.js`, never API responses, auth endpoints, the legacy shell or task
data. Wait for **Ready to reopen this inbox offline** before relying on offline
reload. Reopen the inbox URL, not the legacy `/` entry point. Browser termination
preserves the cache and IndexedDB under normal browser storage retention.
For a shell update, change the cache version in `inbox-sw.js` with the assets,
keep compatible IndexedDB/API contracts, and close all inbox tabs before reopening
online to activate the waiting worker. Do not force-activate incompatible clients;
the fuller update/recovery UX is #14. There is no install manifest in this change.

## Controlled rollout

1. Keep production flags unchanged. In isolated staging, enable
   `V1_API_ENABLED=true`, then open `/inbox.html` directly with disposable accounts.
   This explicit staging URL does not import legacy data. Do not edit live user
   data in both clients/namespaces.
2. Complete the trusted-ingress gates in [Request security](request-security.md)
   and the frozen export, preparation, restore and comparison rehearsal in
   [Versioned data API](data-api-v1.md). Keep original settings/defaults in the
   migration archive; this focused client does not yet edit advanced defaults.
3. After migration verification, set **both** `V1_API_ENABLED=true` and
   `V1_CLIENT_ENABLED=true`. The authenticated legacy shell redirects to the
   durable inbox. The shared API guard rejects every legacy mutation with 409,
   including requests from an old open tab; its form text is retained. No source
   default enables this cutover.
4. Verify two real accounts and physical phone/desktop behavior before inviting
   pilot users. After v1 writes, rollback requires retaining/reconciling that new
   work; do not simply point users back at the old namespace. Follow #4's backup
   and rollback procedure.

## Verification and remaining gates

Run `npm test` in `api/` (Node 24+ for module-mocking tests). Use
`PLAYWRIGHT_CHANNEL=msedge` on a machine with Edge, or install Playwright Chromium
as in CI. The existing HTTP/HTMX, security, transaction and migration tests remain.

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
- Cutover redirects and rejection of every registered legacy mutation.

Local verification uses Edge 154 and Node 26.7 on Windows. These are browser
automation checks, not physical Android/iPhone keyboard or OS-eviction evidence.
Azure auth/Cosmos behavior, staging migration/rollback, real storage exhaustion,
screen readers and physical phone/desktop checks remain unverified release gates
in #3/#4/#5/#14/#16/#17. Keep #5 open until its real-device evidence is recorded.
