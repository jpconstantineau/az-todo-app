# Editable briefs (issue #12)

Choose **Brief** beside a task, or select a project in Your Work and choose its
**Brief** button. No model, download, network inference or API key is required.
The native side panel uses the existing design tokens and becomes a scrollable
sheet on phones. All actions remain keyboard accessible; closing returns focus
to the originating task/project button.

## Purpose, field guide and example

A Brief is an optional working description that prepares a task or project for
action, review or handoff. It brings the desired result, relevant context, scope
boundaries, a proposed next action, acceptance checks and unanswered questions
into one reviewable place. It does not perform the work, create an action from
the proposal, prioritize or schedule anything, or send or share content.

Use a Brief when the work is ambiguous, has several constraints, needs project
planning or review, or needs a clear handoff. Skip it when the action is already
obvious: **Buy milk** usually needs no additional description. Choose the
briefcase beside a task, or select a project and choose **Brief**. The template
uses current saved source details and accepted clarification or planning context
when available. Treat **Unknown** as a prompt to decide or investigate, not an
assertion. The template never invents dates or assignees.

The editor keeps these seven fields in this order:

- **Desired outcome:** what should be true when the work is successfully
  finished.
- **Context and supplied sources:** the available background, constraints and
  source material.
- **Scope:** what this piece of work includes.
- **Exclusions:** what is deliberately outside this piece of work.
- **Proposed next action:** one concrete, visible step that could move the work
  forward. It remains wording in the Brief rather than a newly created task.
- **Acceptance checks:** observable checks that show the desired result has
  been reached.
- **Missing information (or explicitly None known):** questions or facts still
  needed. Enter **None known** only after reviewing them.

For example, a community workshop Brief could say:

- **Desired outcome:** Twenty residents leave with a one-page
  emergency-preparedness checklist they can use at home.
- **Context and supplied sources:** Preserve the neighbourhood association's
  request, the venue guide and feedback from the previous workshop.
- **Scope:** Prepare one 90-minute workshop, a take-home checklist and time for
  questions.
- **Exclusions:** Individual emergency plans and a remote broadcast.
- **Proposed next action:** Confirm the venue's available dates and capacity.
- **Acceptance checks:** The venue, agenda and handout are ready, registrations
  are open and a feedback method is prepared.
- **Missing information (or explicitly None known):** Budget, accessibility
  needs, interpreter demand and speaker availability.

Briefs can complement several personal-productivity approaches without being a
requirement of any of them:

- In GTD, a Brief can be project support material during clarification, the
  [Natural Planning Model](https://gettingthingsdone.com/2024/11/the-natural-planning-model/)
  or review. Its proposed next action is not an action-list entry. See also the
  broader [GTD workflow map](https://gettingthingsdone.com/wp-content/uploads/2024/05/GTD_workflow_map.pdf).
- In 7 Habits, outcome and acceptance wording can support
  [Habit 2: Begin With the End in Mind](https://www.franklincovey.com/courses/the-7-habits/habit-2/).
  A Brief may inform priority choices, but it does not prioritize work or
  reserve time, consistent with
  [Habit 3: Put First Things First](https://www.franklincovey.com/courses/the-7-habits/habit-3/).
- In PARA, context and sources can support an active Project. The app does not
  automatically file or archive a Brief or turn it into a Resource. See Tiago
  Forte's
  [PARA overview and examples](https://fortelabs.com/blog/organize-your-bookmarks-with-the-para-method-for-lightning-fast-web-browsing/).

## Generate, review and decide

The template copies the current task title, notes and supplied source links.
For tasks it can use a project outcome and missing-information notes accepted by
the current clarification flow, while ignoring unaccepted proposals; projects use
their saved desired outcome. The task title is a proposed next action, not a new
commitment. Scope, exclusions and acceptance checks remain explicitly unknown
until the user supplies them. Edit missing information to **None known** only after
reviewing the brief. Dates and assignees are never invented.

Typing saves an account-bound device draft. Closing, going offline or reloading
retains that text. **Save new draft revision** queues an immutable content revision
with a new ID. **Accept this revision** and **Reject this revision** record an
explicit decision about that exact saved content. A decision is final for its
revision; edit the content and save another draft if you change your mind.

Acceptance approves the wording of that revision only. It does not complete or
change the source task or project, enqueue the proposed next action, prioritize
or schedule work, or send or share the Brief.

Editing any saved revision disables acceptance and export until the changed
content is saved as a new draft. Earlier accepted revisions remain selectable,
identifiable by ID, and unchanged. Selecting another revision/source while text
is edited requires saving it first. There is no automatic sending to other people
or agents. Local AI rewriting is optional future work and is not required here.

## Export and source traceability

**Export selected revision** downloads only the selected saved revision as plain
text, with its ID, record version, source type/ID/version, previous revision ID,
decision and complete brief content. A draft or rejected revision is labeled
**NOT ACCEPTED**. A pending or failed local decision is labeled **UNCONFIRMED**;
only a server-confirmed accepted record is labeled **ACCEPTED REVISION**.

The original capture and supplied source/selection text remain visible separately
from the editable brief. Brief source IDs refer to the canonical task/project;
generating, editing or deciding a brief never changes those records or originals.
The device JSON export includes all cached source records, brief revisions,
decisions, pending operations and form drafts without dropping fields. Keep that
JSON alongside individual text briefs when a complete original/source recovery
copy is needed. The existing offline validation/round-trip harness recognizes
brief fields. A device export can omit work not yet pulled from another device.

## API and recovery

The additive `brief` record type uses the existing `/api/v1/operations`, records,
receipts and changes endpoints. Deploy the API before the updated client. No
IndexedDB, partition, authentication or cursor migration is needed.

A create has `subjectType` (`item` or `project`), `subjectId`, `sourceVersion`,
`previousBriefId` (null for a fresh template), `status: "draft"`, and `content`
with seven required text fields: `outcome`, `context`, `scope`, `exclusions`,
`nextAction`, `acceptanceChecks`, `missingInformation`. Each is limited to 4,000
characters; the existing 32 KiB record and 64 KiB operation limits also apply.
Oversized text is rejected, never silently truncated.

Source and previous-revision references are validated within the authenticated
account. A fresh template requires the observed source version to remain current.
An edited historical revision retains its predecessor's source version; it does
not claim to incorporate later task edits. Choose New template draft to start
from the latest task/project facts. Deleted/unavailable sources cannot create
new brief revisions. Existing revisions are retained, including after source
deletion, and are not erased through the brief API.

Updates can only decide a draft as accepted or rejected, using its expected
record version. Content, source references and lineage cannot be overwritten,
even by directly calling the API. `updatedUtc` and the record version identify
the recorded decision. Retrying the exact operation returns the same receipt;
competing decisions produce the existing durable conflict without changing the
winning revision. A conflict cannot use generic automatic reapplication: inspect
the comparison, export a recovery copy if needed, choose the server version, then
reopen the brief. New content requires a fresh draft and explicit decision.

A stale source or invalid reference rejects the save and leaves the queue/form
recoverable. Copy/export the draft, remove the rejected save, and review a fresh
template before incorporating the text. Storage failure exposes the existing
recovery copy outside the modal. Login expiry and account switching hide brief
content and keep pending work with its original account.

## Verification

`api/test/briefs.test.mjs` covers template facts/unknowns, project templates,
immutable content, decision conflicts, lost acknowledgements, source/account
validation, deletion, export round-trip, offline edit/reload/resume, selected
accepted versus draft exports, storage failures, account clearing and responsive
native-panel layouts. [Review screenshots](design/briefs/) cover the panel at
320, 390 and 1440 CSS pixels. Automated browser checks do not establish physical phone,
screen reader or deployed Cosmos/SWA behavior; those remain release checks under #17.
