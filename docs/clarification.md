# GTD clarification (#107)

Clarification begins with **Is it actionable?** and stores one current branching
record shape. Original capture remains available throughout the flow.

- **No:** choose Someday / maybe, Reference, or recoverable Trash. Someday can
  include an optional reconsideration date. Reference stays outside action queues
  and new reviews.
- **Yes:** write one next action, choose or create a project relationship, and
  consider the two-minute rule. A new project requires a title and desired
  outcome; a standalone action needs no project.
- **Do now:** choose **I have done it** only after doing the action. Answering the
  two-minute question, stopping, or closing never completes work.
- **Do later:** choose Next, Waiting with a dependency and optional follow-up,
  Next with a planned day, Deferred with a start date, or Dropped.

The organization step can change the working title and memberships and can record
optional missing-information notes. Existing deadlines and item notes are retained
unless the final summary explicitly shows a change. Trash goes directly to its
confirmation summary and retains the original item for Deleted/Restore.

## Save and apply behavior

**Continue** saves the current answer and next step without changing the item.
Typing journals a device draft; **Save proposal without accepting** queues the
current proposal for sync. **Stop for now** or Escape retains the draft. **Back**
confirms that the preceding answer and current unsaved wording will be cleared,
then restores that answer as an editable proposal.

Only **Apply decision** changes the item. The completed clarification, item
update/deletion, and optional project creation share one version-checked operation
and one server batch. The server derives the exact allowed item changes from the
accepted answers, so a partial or forged decision is rejected. Concurrent changes
cannot silently overwrite one another, and failed project creation cannot leave an
orphan assignment.

Opening a completed clarification and choosing **Clarify again** starts a fresh
pass from the current item. The previous applied item state remains until another
decision is applied.

## Current record contract

A clarification record has the same ID as its owned item and uses this complete
shape on every create or update:

```json
{
  "flowVersion": 2,
  "step": "actionable",
  "answers": {},
  "proposal": {
    "text": "",
    "choice": "",
    "projectId": "",
    "projectTitle": "",
    "outcome": "",
    "waitingOn": "",
    "reviewDate": "",
    "startDate": "",
    "plannedDay": "",
    "listId": "",
    "notes": ""
  }
}
```

`step` is one of `actionable`, `nextAction`, `project`, `twoMinutes`,
`disposition`, `organize`, `summary`, or `complete`, as allowed by the chosen
branch. `answers` contains exactly the preceding steps on that branch. The API
rejects numeric steps, omitted flow versions, obsolete answer wrappers, future or
branch-incompatible answers, invalid dates, unknown fields, and final mutations
that differ from the accepted decision.

The current device and server export validators require this version and named-step
shape for clarification records and queued clarification mutations. Exports retain
the complete answers, unaccepted proposal, tombstones, conflict versions, pending
operations, and current/device drafts; they never interpret an export as a restore
instruction.

## Persistence, guidance, and conflicts

There is one active unsaved clarification form per browser profile. Switching to
another task while wording is unsaved reopens the current form and asks the user to
save it first. Saved progress is a separate record for each task and reaches other
devices through foreground sync. Stopping alone does not upload unsaved typing.

Optional local guidance is available only for the next-action wording. Suggestions
are plain-text, unaccepted proposals; the user must explicitly use and continue
them. Manual clarification remains available when the browser model is absent,
unavailable, downloading, or fails.

Session and item changes use expected versions, stable operation IDs, receipts,
and the normal conflict queue. Repeating an acknowledged operation does not advance
twice. A stale final decision conflicts atomically. Deleted tasks cannot be
resurrected through clarification. Account or workspace changes clear visible
private content, and a device write failure exposes the recoverable draft without
adding a false pending operation.

## Verification

`api/test/clarification-flow.test.mjs` covers branch validation, all dispositions,
Back, Stop, reload, re-clarify, local drafts, atomic Apply, project creation,
Trash/restore, conflict and lost-acknowledgement behavior, workspace/account
isolation, current-shape exports, and storage failure. `api/test/local-guidance.test.mjs`
covers supported and fallback guidance against the same current flow.

Run `npm test` from `api/` with Node 22.x and Playwright Chromium. Physical phone
keyboards, spoken screen readers, production Cosmos behavior, and deployed SWA
authentication remain release checks under #16/#17.
