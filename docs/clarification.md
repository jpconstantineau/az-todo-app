# Progressive clarification (#9)

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
   maybe, Already done or Drop, wait
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
After all decisions, **Done** closes the completed flow. Non-actionable reference
filing remains the separate scope of #77; Someday is for possible future actions.

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
