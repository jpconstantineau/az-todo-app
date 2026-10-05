# Editable briefs (issue #12)

Choose **Brief** beside a task, or select a project in Your Work and choose its
**Brief** button. No model, download, network inference or API key is required.
The native side panel uses the existing design tokens and becomes a scrollable
sheet on phones. All actions remain keyboard accessible; closing returns focus
to the originating task/project button.

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
