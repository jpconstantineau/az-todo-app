# Automatic local AI capture (#24)

In Capture, open **Free-form task review and local AI** and enable **Automatically suggest with local AI**. A ready local model
proposes text at the cursor after a 1.2-second typing pause. **Tab** or
**Use suggested text** inserts it into Capture; **Escape** or **Dismiss suggestion**
keeps your text. Shift+Tab still moves focus backwards. Moving the cursor or
editing invalidates a suggestion. Suggested text is transient; accepted text is
journalled as an ordinary capture draft. It creates no tasks until you save.
**Suggest tasks now** shows proposed task titles and destinations beside Capture,
with **Review saved suggestions** available even when AI options are collapsed. Only **Accept all tasks on device**
commits the reviewed batch. **Suggest tasks now** starts an explicit attempt,
including a browser model download if necessary; typing never initiates downloads.

When the header agent is unavailable, both AI checkboxes and **Suggest tasks now**
are disabled. Manual capture and task review still work. Saved AI preferences stay
with the draft and become usable again when this device supports the model;
availability changes and reloads do not themselves start inference.

**Review tasks manually** opens the same durable batch review without a model,
including for paragraphs longer than a manual one-line title. Add titles and
notes using the exact original; nothing runs through AI. Original notes and the
selected existing list carry into the first task. Stop/reload and resume this
review offline, then accept through the same repeat-safe outbox.

Edit titles, notes, existing-list destinations, priority, context, area and
deadlines. Add/edit/remove rows to split tasks. **Merge into previous task** keeps
the previous title and appends the removed task's title, notes, attributes and
warnings to its notes. A merge over 4,000 characters changes neither task. Stop and keep the review,
reload offline, and resume corrections. Existing corrections are never replaced
by another inference. If Capture changes, acceptance is blocked until that review
is discarded and the new text processed. Manual one-item-per-line capture and
split preview remain available when AI is disabled, missing, cancelled or failing.

The automatic preference belongs to this workspace's draft in the account's device copy. Reload and
reconnect do not themselves run inference; the next edit triggers it when enabled.
Account changes cancel generation and hide its content. Suggestions are English
only, using matching language/modality options and session cleanup shared with
clarification guidance. See the [Chrome Prompt API](https://developer.chrome.com/docs/ai/prompt-api).
No external inference service, API key or task-text logging is introduced. The
prompt contains this capture, its notes and the captured clock. Existing list
names/IDs are included only after enabling **Include my existing list names in
local AI suggestions**. This preference persists per workspace and account on this device.
The option shows the included names (or that none exist in this workspace);
changing it cancels an in-flight attempt and refreshes automatic suggested text.
Saved review corrections are preserved and the choice applies to the next batch.
This supplies context; destinations still need review before saving. An explicitly selected destination is
still applied locally even without sending list names to the model.
Accepted tasks still use ordinary cloud synchronization.

## Sources and dates

Each accepted item retains the exact `originalText`, plus immutable `captureId`,
`capturedAt` and `captureTimeZone` metadata shared by items from the same capture.
This association survives edits, export and deletion. Existing records need no
migration. Device exports also retain unaccepted review drafts; server exports
contain accepted tasks and their provenance.

The clock updates when capture text changes and survives reload. Relative dates
use that clock, not a later processing date. For example, a Regina capture at
`2026-10-03T05:30Z` has local date October 2; “tomorrow at 3 pm” means October 3,
`21:00Z`. Date-only suggestions use `dueDate` without an invented time. Specified
times are resolved in the captured timezone even if the browser changes zones.
Skipped/repeated DST times are rejected instead of guessing an offset.

Generated tasks must cite exact source excerpts. Unknown lists, invalid dates
and tags absent from the source are left unset for review. Syntactic validation
cannot prove correct task boundaries or date interpretation: every result is an
unaccepted suggestion. Non-actionable/grouping notes appear in review; original
text remains on every accepted task. A zero-task result stays a device draft,
with the option to add tasks manually.

## Durability and limits

IndexedDB journals source text and corrections before reporting them saved.
Model initialization may begin during a download-enabling click, but inference
receives no capture until persistence succeeds. Changed text, cancellation,
timeout and account switching invalidate late results. Attempts have a two-minute
limit and no automatic retry loop.

Acceptance validates the current draft and list references, then queues all tasks
and clears the review in one local transaction. Stable item IDs and `captureId`
reject stale-tab duplicate acceptance. Outbox retries retain their operation ID,
including after lost acknowledgements. Existing server ownership, relationship,
text and size validation still applies; provenance is create-only.

Limits remain 16,000 source characters, 200 title characters, 4,000 note
characters, 20 tasks and 64 KiB per operation. Repeating the source on each task
means long captures can hit the batch limit with fewer than 20 tasks. Oversized
acceptance queues nothing and keeps the complete review for copy/device export.
Reduce the capture or the batch and review again; nothing is silently truncated
or partially accepted. Existing storage/queue failure recovery applies.

## Verification and release evidence

From `api/`, run:

```sh
node --experimental-test-module-mocks --test test/capture-extraction.test.mjs
```

Checks cover paragraph/multiline fixtures, source grounding, immutable metadata,
invalid/oversized output, date-only/DST semantics, automatic opt-in, offline
correction/reload, cancellation/late results, account changes, manual fallback,
add/remove review and lost-acknowledgement/stale-tab duplicate protection.
Inference is mocked; writes exercise production API handlers with the existing
in-memory Cosmos substitute. [Review screenshots](design/capture-extraction/)
and responsive checks cover 320/390/1440px in both themes.

Keep #24 open for real supported-device Gemini Nano extraction quality/latency,
physical phone/keyboard and screen-reader acceptance. Before widening rollout,
run the paragraph, multiline single-task, tomorrow-at-3pm, ambiguous date,
unknown-list and adversarial examples with the real model. Proposed quality gate:
all source facts retained, no invented tasks/dates in the fixture set, zero
automatic commits/duplicate writes, and ready-model suggestions within 10 seconds
for ordinary captures. Measure and agree these thresholds with the owner; mocks
do not establish model quality or latency.

The [representative quality fixtures](../api/test/fixtures/capture-quality.json)
are manual real-model checks, not claims that mocked output establishes model
quality. The capture flow keeps one API/provenance/draft format for automatic
suggestions, manual batch review, list-context permission and merging. No parallel
capture UI or second capture metadata format is shipped. Storage-recovery checks
wait for the corrected draft to persist and the current failed save to close its
dialog before reading recovery text.
