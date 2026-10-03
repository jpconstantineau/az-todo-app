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
Sync first to include newer remote changes. Each batch contains up to 200 records.
When more are eligible, the panel shows the remaining count before any decisions
and offers **Review next batch** after the current batch is finished. Continuation
excludes every identity included in earlier batches, including retained work;
there is no need to falsely complete or drop commitments. It uses current device
records, so later captures can appear in the next batch. Previous batches remain
selectable in Saved reviews. A completed batch is labelled separately from a
complete standalone review. Empty reviews are explicitly complete.

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
`reviewKind`, `reviewDay`, `included: [{type,id}]`, empty `decisions`, and optional
`previousReviewId` for a continuation in the same workspace, kind and day.
Continuation IDs are a deterministic SHA-256 of the previous ID so concurrent
starts conflict instead of duplicating the next batch.

New decisions are separate immutable `reviewDecision` records. They contain
`reviewId`, monotonic `sequence`, included-record `index`, `choice`, observed
`recordVersion`, the complete `before` workflow, and only changed fields in
`changes`. Overlaying changes on before reconstructs the exact after state,
without duplicating a long waiting-for description. A review stores a bounded
`decisionHeads` array (one latest decision ID per included record) and
`decisionCount`. The first undecided record is the resume position; earlier
records remain selectable. IDs and references stay stable.

A decision, review-head update and action update share one operation, with
expected versions for all records. The server validates the next sequence,
single changed head, paired immutable decision, exact action edit, prior/next
states, reference ownership and undo eligibility. Cosmos commits all or none.
Retrying identical operation IDs/content returns the
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

Decision records retain the 32 KiB cap; operations retain 64 KiB, and the device
queue retains 100 saves / 5 MiB. Sync or export when the queue is full, then
resume. Review metadata with separate history permits 64 KiB to fit 200 maximum
length identities, 200 bounded decision IDs, and preserved legacy history. Its
size no longer grows with repeated undo/redecision. No other record cap changes.

Existing inline decisions remain immutable and visible. A nearly full old
review resumes by appending separate decisions, including undo of an inline
decision. Legacy appends still use the original 32 KiB / 200-entry limits; once
a review uses separate history, old clients receive an update-app error instead
of overwriting progress. Exports include every decision, session, pending
operation and local draft in JSON and readable text.

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

`api/test/review-capacity.test.mjs` completes a 200-item production-handler review
with 128-character IDs and 4,000-character multibyte waiting text, goes beyond
200 decisions with undo/redecision, resumes a legacy review at its byte cap,
checks new-history atomicity/isolation/export, and exercises a 201-item browser
review with offline continuation, reload and another device.

Local verification on 2026-10-02 uses Windows, Node 26.7.0 and headless Edge with
the existing in-memory Cosmos substitute and simulated authenticated accounts.
Screenshots are in `docs/design/reviews/`. Physical phone keyboards, screen
readers and deployed SWA/Cosmos concurrency remain release gates under #17.

Ship API support before or atomically with the updated shell. Older shells keep
unknown decision records during synchronization but cannot display their
progress; update the app before reviewing. Fresh module URLs prevent mixed
shell versions; updates preserve drafts and queued operations.
