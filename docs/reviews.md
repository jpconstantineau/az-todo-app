# Daily and weekly reviews

Use **Daily / weekly review** from any workspace destination. This optional
panel uses native buttons, selects and date input. Escape or **Stop and close
review** returns to the workspace. No timer, AI or prior clarification is required.

Daily reviews include active next actions, today's planned items, overdue/due
deadlines (including timed deadlines later today), and waiting/deferred items ready
for review. Deadlines use the device's local calendar day, including daylight-saving
changes; timed waiting/deferred cues still use the current instant. Weekly reviews
include all active items (including inbox, waiting and deferred) and project outcomes.
Completed, dropped and reference items are excluded from new sessions. Projects can be
retained; review their canonical actions individually to drop or defer them.

A session freezes the included record identities available on this device.
Sync first to include newer remote changes. Later captures appear in a new
review. Empty reviews are explicitly complete; nothing is inferred from
unanswered questions.

## Decisions and recovery

- **Retain** preserves all task fields. Its version advances with the decision
  to detect concurrent changes, without inventing dates or next actions.
- **Drop item** sets `status: dropped` and retains original capture, notes,
  relationships and dates. This is neither deletion nor completion. Dropped
  items remain accessible and editable in Your Work and its status filter.
- **Defer item** sets `status: deferred`, a calendar start date and clears a
  previous timed start value. It does not change a deadline or planned day.
- Select a reviewed record and **Undo selected decision** to restore its prior
  workflow, then choose again. Every undo appends history. Undo requires the
  exact task version produced by the decision; later edits disable it. Normal
  editing and existing workflow undo remain available.
- Deleted/missing records remain visibly unavailable. Acknowledge one to
  continue; it is never recreated.

Sessions/history have no automatic expiry in the current protocol. Undo has a
version boundary, not a timer. Server receipts/change history and exports retain
prior states. Account erasure/retention policy remains separate work under #13.
Review records cannot be deleted through ordinary operations to bypass history.

## Persistence and conflicts

`review` records use the existing account partition. Create fields are
`reviewKind`, `reviewDay`, `included: [{type,id}]` and empty `decisions`. Updates
append exactly one decision: its index, choice, observed record version, and
before/after workflow fields. The first undecided record is the resume position;
earlier records remain selectable. IDs and references stay stable.

A decision and its action update share one operation, with expected versions
for both records. The server validates the immutable decision prefix, exact
action edit, prior/next states, reference ownership and undo eligibility. Cosmos
commits both or neither. Retrying identical operation IDs/content returns the
same receipt without another decision. Concurrent decisions conflict normally.

The panel distinguishes pending, failed and server-confirmed progress. Sessions
resume after offline reload on this device. Another signed-in device can resume
acknowledged sessions through the saved-review selector after syncing. Selected
review/record and an unsubmitted defer date are local drafts, shared by tabs of
the same browser profile. Account changes hide them.

For conflicts, close the panel, compare pending/server versions, export if
needed, and use the server version for that failed save. Then reopen the session
and inspect the latest records. Review batches do not offer blind replay against
newer versions. Later queued decisions may need the same explicit resolution.
Old decisions cannot resurrect deleted items.

Existing 32 KiB record, 64 KiB operation, 100 queued-save and 5 MiB queue limits
apply. Reviews additionally cap included identities and decision entries at 200;
large text histories may hit the byte cap earlier. Errors remain visible and
never silently omit records or claim a save. Keep/export history and start a
new session when its history is full. More than 200 eligible records requires
reducing active work before starting; paginated history is a future scaling
change. Exports include sessions, history, pending operations and local drafts
in JSON and readable text; the validation harness recognizes their fields.

## Verification and rollout

Run `npm test --prefix api` with Node 24+ and Playwright Chromium, or
`PLAYWRIGHT_CHANNEL=msedge` on Windows. `api/test/reviews.test.mjs` covers atomic
rollback, duplicate delivery, immutable history, paired edits, version conflicts,
undo limits, foreign references, concurrent decisions, deletion acknowledgement,
empty reviews, offline reload, second-device resume, dropped-state recovery and
account switching. `api/test/daily-review-deadlines.test.mjs` verifies whole-day
deadline inclusion, local midnight boundaries, spring/fall DST transitions,
unchanged waiting/deferred cues, and offline review resumption. Layout checks
cover 320/390/768/1440/2560 CSS pixels.

Local verification on 2026-10-02 uses Windows, Node 26.7.0 and headless Edge with
the existing in-memory Cosmos substitute and simulated authenticated accounts.
Screenshots are in `docs/design/reviews/`. Physical phone keyboards, screen
readers and deployed SWA/Cosmos concurrency remain release gates under #17.

Ship API support before or atomically with shell v12. Older shells synchronize
unknown review records without exposing review controls. Fresh module URLs
prevent mixed-version shells; updates preserve drafts and queued operations.
