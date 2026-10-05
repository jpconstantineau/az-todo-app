# Native task flow and parity verification

Implementation for issue #25. `/` serves `html/index.html` and is the canonical
workspace URL. Capture is the default. [Capture, Your Work and List Workspace](navigation.md)
are separate addressable views that keep drafts intact.

## User flow

| Action | Native implementation / contract |
| --- | --- |
| Sign in/out | SWA auth; return to `/`; verify `/api/v1/session` before displaying account data |
| New empty list | List Workspace → New list editor; versioned `list` create with title, notes and a snapshot of user defaults |
| Capture | One item per non-empty line; optional original-preserving split preview, notes and new/existing list |
| Advanced task fields | Status, local due date/time, contexts, areas, energy, time and priority; native controls |
| Review/filter | Your Work: all items, inbox, list, project or planned day, combined with status filter; local view over every fetched change page |
| Edit/move | Title, notes, list and advanced fields; only changed fields sent, retaining links, dates with seconds and originals |
| Complete/reopen | Explicit status write; completion stores prior status; reopen restores it, falling back to `next` for older records without one |
| Defaults | User defaults or per-list options in a native dialog; one option per line, at most 200 per field and 64 characters per option |
| Reset/copy | Reset user defaults to built-ins, or copy current user defaults into a list form; Save confirms the snapshot as an ordinary versioned operation |
| Recovery | Durable drafts, queue status, conflict comparison, selectable recovery copy and device export |

All mutations use `POST /api/v1/operations`. The same queue/receipt/version rules
apply to settings and tasks; there are no fragment requests or OOB swaps. New lists
copy effective user options; lists without overrides inherit them. Removed options
do not erase existing task values. Capture status defaults to `inbox`, so optional
classification never obstructs quick capture.

Local date input is converted to UTC. Nonexistent local times during a DST jump
are rejected; ambiguous times use the browser's Date interpretation. Display uses
the browser timezone. Date-only/recurrence semantics are outside this change.

Saving or refreshing defaults updates options without replacing capture/editor
text. Defaults drafts, selected view/filter and workspace choice join the existing
account draft document. Same-profile tabs still share that draft slot; submitted
operations remain independently durable. Individual records are limited to 32 KiB
and operations to 64 KiB, including defaults snapshots.

## API endpoints

The current client uses only the versioned private and shared JSON endpoints.
Retired pre-v1 paths are unregistered and receive the platform's normal not-found
response. The shared guard authenticates every registered route and verifies the
origin of every current mutation; there is no recovery shell or fallback writer.

## Verification

From `api/`, use Node 22.x, `npm ci`, `npx playwright install chromium`, `npm test`.
Alternatively use installed Edge with `PLAYWRIGHT_CHANNEL=msedge`.

- `browser.test.mjs`: replaces the old HTMX flow with native settings, list creation,
  advanced fields, custom status filters, safe text, dates, offline reset/copy and
  completion/reopen parity.
- `contracts.test.mjs`: v1 gate states, retired-path not-found responses, local shell and CSP.
- `inbox.test.mjs`: persistent browser restart, exact queued retries, conflicts,
  isolation, transaction/quota failure, competing tabs, shell upgrade and drafts.
- `v1.test.mjs`: atomic batches, bounded changes, validation, repeat-safe settings
  and settings conflicts, preserved prior status and custom values.
- `security.test.mjs`: origin policy, every route's authentication and headers,
  read isolation, no GET writes, shared registration guard.
- `account-export.test.mjs`: fixed-cutoff server export, tombstones, concurrent
  writes, validation and round-trip preservation.
- `design.test.mjs`: populated layouts at 320–2560px, modal focus, themes and contrast.

These checks are local automation, not evidence of live Azure topology, real Cosmos
isolation/transactions, physical phones or screen readers. Keep #3/#4/#5/#17 open
until their remaining deployed checks are recorded. See the inbox release checklist
before merging/deploying the replacement client.
