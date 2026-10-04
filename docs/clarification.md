# GTD clarification (#107)

New clarification sessions begin with **Is it actionable?**, without requiring an
outcome or action for reference information. Original capture remains available.

- **No:** Incubate (Someday / maybe), Reference, or recoverable Trash. Incubation
  has an optional reconsideration date. Blank explicitly clears an earlier review
  cue. Dated Someday becomes Ready for review when due, never automatically Next.
  Undated Someday remains in weekly reviews; Reference stays out of new reviews.
- **Yes:** Write a next action, choose a project relationship, and consider the
  two-minute rule. Existing projects retain their outcome; a new project requires
  a title and desired outcome. Standalone actions need no project.
- **Do now:** Explicitly choose **I have done it** after acting. Merely answering
  Yes to the two-minute question, stopping, or closing never completes work.
- **Do later:** Do when possible uses Next. Delegate uses Waiting with a required
  person/dependency and optional date (blank preserves existing cues). Plan for a
  day uses Next plus a planned day; Not before uses Deferred plus a start date.
  Existing deadlines are retained and separately labelled. Nothing is sent to
  another person or an external calendar.

Choose an optional list and edit the working title before the final summary.
Missing-information notes belong to the clarification, separate from item notes.
Existing project/list membership is preserved unless deliberately changed.
Trash goes directly to its confirmation summary and retains the original item
for the existing Deleted/Restore flow. Drop remains a distinct workflow status.
Context, time and energy remain available in ordinary Task details.

## Save and compatibility contract

**Continue** saves the answer and next step, with no item mutation. Typing journals
a device draft; **Save proposal** queues progress for foreground sync. **Stop for
now** or Escape keeps the draft without accepting it. **Back** confirms discarding
the preceding answer/current unsaved wording, then restores that answer as a
proposal. Users can backtrack across branches without undoing task mutations.

Only **Apply decision** changes the item. The final session, item update/deletion,
and optional project creation share one version-checked operation and server
batch. The server verifies the exact changes against the accepted answers.
Concurrent task changes cannot silently overwrite one another; failed project
creation cannot leave the task pointing at a missing project. Existing receipts,
conflict recovery, export, workspace isolation and original-text protections apply.

New records use `flowVersion: 2`, a named `step`, typed `answers`, and a bounded
unaccepted `proposal`. The branch includes actionable, nextAction, project,
twoMinutes, disposition, organize, summary, and complete as applicable. Trash
omits organize. Summary/complete require all applicable answers. Branch-incompatible
answers and final mutations are rejected. No flow version means the legacy v1
questionnaire below: existing sessions, device drafts and queued requests continue
unchanged. The API rejects changing an existing session's flow version.

Deploy compatible API support before shell v52; do not downgrade that API while
v2 operations are queued. The full cached module graph includes
`clarification-flow.js`. No database migration, partition change, receipt rewrite,
new dependency or device-storage reset is needed. #117 can replace the current
list/project selectors with its common organizer independently.

## Verification

`api/test/clarification-flow.test.mjs` covers branch validation, all dispositions,
custom status settings, date semantics, atomic project creation, stale/deleted and
foreign records, lost acknowledgements, legacy-version protection, Back,
offline stop/reload/resume, storage failure, workspace/account switches, and Trash
restoration. The existing clarification/local-guidance tests explicitly start
legacy sessions to preserve upgrade coverage. Navigation and keyboard tests exercise
the new flow. Shell upgrade tests preserve exact operations from earlier shells.

Screenshots in `docs/design/gtd-clarification` cover the new decision panel.
Physical devices, spoken screen readers and production Cosmos/SWA behavior require
deployment validation beyond the local handler/IndexedDB browser harness.

## Legacy progressive clarification (#9)

Capture remains a one-step save. In **Your Work** or **List Workspace**, choose
**Clarify** on an existing task when you want to work through it. No AI API,
model download, inference service or additional dependency is needed.
[Optional local guidance](local-guidance.md) can suggest wording for the first
three questions on supported desktops; all decisions still use this manual flow.

The native dialog uses the existing theme, controls and responsive side-panel
styles from `DESIGN.md`. It asks one optional question at a time.

For an already clear capture, **Choose disposition — skip remaining questions**
jumps straight to the state decision from any of the first three questions.
It records the remaining questions as skipped, preserves accepted answers and
original text, and does not change the task until a disposition is accepted.
If the current question has proposed wording, accept it or explicitly clear it
first; the shortcut never silently discards that wording. No AI, project,
deadline or completed questionnaire is required for a simple next action.

1. What outcome would resolve this? Accepted wording is a clarification fact;
   it does not silently create a project.
2. What is one concrete next action? Accepting replaces the task title with
   the exact supplied wording. Status is unchanged.
3. What information is missing? Supply the unknowns or explicitly enter
   “None known”. Skipping means unknown, never an inferred answer.
4. What happens next? Explicitly keep the existing state, choose Next, Someday /
   maybe, Reference, Already done or Drop, wait
   for a named person/dependency with an optional review date, or defer until a date.
   A blank waiting review date preserves any existing calendar or timed cue;
   use the item editor to clear one. Undated waiting work stays in weekly reviews.
   The last two use the existing workflow validation and calendar-date semantics.
   Deadline, planned day, project and list membership remain intact.

At each question the user can edit their proposed answer, **Accept answer**,
**Skip question**, **Save proposal without accepting**, or **Stop for now**.
Escape also stops. There is no timer or default commitment. **Original request**
is always available, and **Accepted answers and unknowns** shows all four questions
with unanswered/skipped distinctions. Accepted facts remain separate from source
text; the API still forbids editing `originalText`.
After all decisions, **Done** closes the completed flow. Reference keeps useful
non-actionable information outside action queues and new reviews. Retrieve and
edit it using the reference status filter or All statuses; Someday is for possible
future actions.

## Persistence and conflicts

Typing journals the device draft in IndexedDB. “Draft saved on device” appears
only after the transaction commits. Stopping keeps that draft and the current
step; reload restores an open dialog, and reopening Clarify restores a stopped
draft. Saving a proposal queues the session without editing its task. Accept/Skip
queues the decision and advances exactly one step after the local commit. The
disposition shortcut saves all remaining skips together and resumes at the state
decision, including offline after reload. A task
edit and its associated accepted decision share one operation and one server batch.

As with the ordinary editor, there is one active unsaved clarification form per
browser profile. Switching tasks with unsaved wording reopens the current form
and asks you to save its proposal first; it never silently replaces that wording. Same-profile
tabs share the device draft slot. Accepted progress and saved proposals have a
separate versioned record for each task, so they survive moving between tasks and
reach another signed-in device through foreground sync. Stopping alone does not
upload unsaved typing. Offline work requires a previously verified account and a
ready shell; clearing device storage loses unsynced work.

Session and task changes use expected versions, stable operation IDs, durable
receipts and the existing conflict queue. Two devices cannot silently overwrite
the same session, even when accepting different questions. A stale task acceptance
also conflicts atomically. Repeating an accepted operation after a lost response
does not advance the step twice. Pending/server comparisons include session step,
answers and unaccepted proposal. Existing explicit resolution applies to updates;
a competing first-session create requires keeping the server session and manually
re-entering the preserved proposal, after exporting it if needed. Later queued
decisions may require their own review. Deleted tasks cannot be resurrected.

Account switches and logout clear the dialog and its visible private content.
Storage failure closes the dialog and exposes a copyable recovery snapshot.
Portable JSON/text exports preserve session records, exact pending operations,
conflict versions and the current/device clarification drafts.

## API and rollout

`clarification` is an additive v1 record type. Its ID equals its owned item's ID;
storage is `record:clarification:<itemId>` in the existing account partition.
No data migration, key change, receipt rewrite or cache reset is needed.
The direct-disposition release expands the accepted statuses to `someday`,
`completed` and `dropped`; deploy that API support before the updated shell.

Create/update supplies the full `{ step, answers, proposal }` snapshot:

- `step`: integer 0–4, the next question; 4 is complete.
- `answers`: the preceding question keys (`outcome`, `nextAction`, `missingFacts`,
  `disposition`), each `{ decision: "accepted", value }` or
  `{ decision: "skipped", value: null }`. Future keys are prohibited.
- Accepted text is nonblank, at most 4,000 characters (200 for `nextAction`).
  Accepted disposition has `status`, `waitingOn`, `reviewDate`, `startDate`.
- `proposal`: `{ text, status, waitingOn, reviewDate, startDate }`. Empty/incomplete
  values are permitted until acceptance. Dates, when supplied, must be valid
  YYYY-MM-DD values. Only explicitly relevant disposition fields become answers.

The server verifies the referenced task is live in the authenticated account.
The client submits task mutations only on explicit acceptance; a session write
alone never interprets a proposal as an instruction to mutate the task. Both
records use normal version checks and change-feed delivery. A deleted item's
historical clarification is retained for export/provenance, but cannot be updated.

Deploy the additive API before **shell v11**. Older clients ignore this unfamiliar
record type. Do not downgrade the API while clarification operations are queued;
retain the API and roll back the shell if needed. Shell v11 includes the navigation
and portable export changes merged through `b357abf` (PRs #34 and #35).

## Verification evidence

On October 2, 2026, Windows, Node 26.7.0, Playwright Chromium 153.0.8010.12:
the integrated `npm test` suite passes **82/82**, none skipped. The suite uses
production handlers with the existing in-memory transactional Cosmos substitute.
Focused checks cover schema/ownership, atomic failure, lost acknowledgements,
stale/deleted tasks, unknown answers, offline stop/reload/resume, editable proposals,
AI API absence, separate browser-context conflicts/resolution, account isolation,
storage failure and export round-trip. Existing navigation/export/PWA/security
checks pass, including shell upgrades from versions 3 through 10.

Screenshots in [design/clarification](design/clarification) show the integrated
dialog at 320/390/768/1440 CSS pixels, with overflow assertions. The dialog uses
native modal keyboard semantics and returns focus to the active destination.
Physical phone keyboards, screen readers, non-Chromium browsers and deployed
SWA/Cosmos behavior remain unverified release checks under #16/#17.
