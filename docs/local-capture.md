# Free-form capture and reviewed tasks (#24)

In Capture, enter thoughts in the existing text box, then open **Turn free-form
thoughts into tasks**. **Suggest tasks** invokes Chrome's local Prompt API only
on request. **Review tasks manually** supports the same batch editor without a
model. The usual one-item-per-line save and explicit punctuation preview remain
available. No framework, dependency, remote AI service or API key is introduced.

## Review and persistence

Every field is labeled an unaccepted suggestion. Edit titles/notes, expand Task
details for an existing destination list, calendar/timed deadline, priority,
contexts and areas. Remove suggestions or merge into the previous task; merging
preserves the removed task's attributes in notes. To split, add a task and move
the relevant text. Existing manual capture detail settings do not silently fill
AI fields. New lists, projects and workflow-state inference are outside this
first extraction flow. All accepted tasks enter Inbox status.

The original source, notes, capture UUID, timestamp and timezone live in the
existing account-scoped IndexedDB draft. Source changes start a new capture
revision; retrying/reprocessing the same source keeps its capture time. Inference
does not receive the source until a local journal transaction commits. A model
session may initialize/download concurrently to preserve click activation.
Suggestions and each edit journal to that same draft; reload restores them
without inference. No tasks are created until **Accept and save tasks on device**.
No-action output leaves the original in the draft and permits manual additions.

Acceptance commits the whole batch to the existing outbox and clears its draft
in one transaction. Stable item IDs also prevent another tab from accepting the
same preview twice. Existing operation IDs, receipts, retries, account isolation,
relationship checks and conflict recovery apply. A failed transaction retains
the review with copy/export recovery. A failed server save remains in the outbox
for normal recovery. Inference cancellation, edits, tab hiding, panel closure and
account changes invalidate late results and release sessions. Inference times out
after 60 seconds; model downloads have a Cancel control. A pending review must be
explicitly discarded before asking for replacement suggestions. Discarding it
does not change the original text.

As with other forms, this is one shared draft slot per account/browser profile,
not independent drafts per tab. Drafts do not sync to another device. Device
export includes current/saved drafts; accepted records and exports retain the
exact `originalText` plus immutable `capture` metadata (`id`, `capturedUtc`,
`timeZone`, and original `notes`). Normal item edits preserve these fields.
Clearing site storage or losing the device loses unsynced drafts.

## Dates, privacy and bounds

Supported extraction is English. The model supplies source date/time phrases,
not arbitrary UTC timestamps. Deterministic conversion handles `today`,
`tomorrow`, `day after tomorrow`, or `YYYY-MM-DD`, optionally with `HH:mm` or
`h[:mm] am/pm`. Relative days use the recorded capture date in its timezone,
including after a delayed retry or device timezone change. Date-only phrases
remain calendar dates. Unsupported/ambiguous phrases, missing date with time,
and nonexistent/repeated DST times stay unset and display a review warning.
Users can correct dates or enter an ISO timestamp with an explicit offset.
Expand date/language rules when real capture examples establish their intended
meaning; no calendar library or guessed timezone is introduced.

Only source text, notes, capture time/timezone and optionally **explicitly
enabled existing list names/IDs** enter the local prompt. No other records,
account identifiers, source-page fetches or credentials are supplied. The model
cannot write records or choose an account. Unknown destination IDs become Inbox
with a warning; the server still verifies account-owned list relationships.
Output must match bounded structured JSON; extra fields and malformed/oversized
output fail without changing the source. UI text uses native text/value APIs.
Model guesses can still be wrong: compare every batch with the original.

Input remains bounded to 16,000 characters plus 4,000 notes; output is at most
64,000 characters with 20 suggestions, 200-character titles and 4,000-character
notes. Acceptance keeps the existing 20-mutation/64 KiB operation, 32 KiB record,
100-operation/5 MiB outbox limits. Repeating originals across tasks may hit byte
limits earlier. A rejected batch is never partially committed: remove suggestions
or shorten their notes, or export/copy the source and process smaller captures.
Originals are never silently truncated. Explicitly capturing the same text again
is a new intent and can create duplicates; delivery retries of one intent cannot.

Uses the [Chrome Prompt API documentation](https://developer.chrome.com/docs/ai/prompt-api)
reviewed October 3, 2026: global `LanguageModel`, matching English/text options,
availability before explicit creation, download progress, structured response
constraints and session destruction. Unsupported browsers keep manual workflows.
The new modules join the public v26 service-worker shell; API/auth/task data never
enter Cache Storage. No IndexedDB migration, database reset or partition change.

## Verification and remaining evidence

After integrating main at `6925eca` (PR #62) and advancing the shell to v26,
all **208 Node/Playwright tests passed** on October 3, 2026. This includes
upgrades from shells v3–v25 and the merged review/brief accessibility checks.
`git diff --check` passed. The earlier sandbox run's extension launch was blocked
by Windows; the host-launcher rerun passed the extension test and full suite.

Focused Node/Playwright checks cover strict parsing, timezone/DST conversion,
immutable server metadata, all-or-nothing size rejection, offline review/reload,
manual fallback, download/cancel/late completion, stale source/account changes,
invalid model output, safe markup, list-name opt-in, quota failures, two-tab
acceptance and lost server acknowledgement. Run from the repository root:

```powershell
$env:PLAYWRIGHT_CHANNEL='msedge'
node --experimental-test-module-mocks --test api/test/capture-extraction.test.mjs api/test/local-capture.test.mjs
```

Screenshots use synthetic captures and mocked model output on Windows with Node
26.7.0 and Edge 154.0.4258.53. The existing dark surfaces, system font, native
controls and spacing tokens follow DESIGN.md; optional fields collapse to keep
review manageable. Checked for horizontal overflow at
[320px](design/local-capture/capture-320.png),
[390px](design/local-capture/capture-390.png) and
[1440px](design/local-capture/capture-1440.png).

Automated tests validate the integration, not Gemini Nano's extraction quality.
Before calling #24 complete, run the [representative fixture set](../api/test/fixtures/capture-quality.json)
on a real supported desktop with a downloaded model and agree quality/latency
thresholds with the owner. Record missed/invented tasks or attributes, exact
original retention, wall time and manual corrections. Proposed quality gate:
no invented dates/destinations, no dropped source text, and each expected action
represented without splitting the single-task fixture; this is not a measured or
owner-approved threshold. The 60-second inference timeout is a recovery bound,
not a latency promise. Physical-phone/screen-reader and real SWA/Cosmos
verification remain #17 release gates. No production rollout or certification
is claimed by these local checks.
