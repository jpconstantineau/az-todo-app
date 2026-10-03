# Waiting, deferred work and dates

Issue #8 adds workflow details to the same canonical actions used by inbox,
project and day views. Capture still needs only text. Open **Task details** to
choose a state and dates; ordinary lists and custom statuses continue to work.

| State | Rule |
| --- | --- |
| Inbox | Captured without a required classification. |
| Next | Ready to act; `nextAction` is derived as true only for this state. |
| Waiting | Enter who/what is awaited. A review date or timed review cue is optional. |
| Deferred | Enter a start date or time. The item becomes ready for review then. |
| Reference | Non-actionable information, kept with its original capture and editable notes. No project, dates, brief or AI required. |
| Completed | Complete preserves the preceding status, dependency and dates. Reopen restores that status. |
| Custom | Configured and historic values remain available; no automatic reinterpretation. |

To file reference material, choose **Reference (non-actionable)** in Task details
or Clarify's disposition (the earlier questions can be skipped). Find it under
Your Work → All items → Status → reference, or All statuses; the same filters
work within its list or project. Reference stays out of the default Incomplete
items filter, Inbox, planned-day view, and newly started daily/weekly reviews,
even if it retains an old date. Existing saved review inventories and history
remain unchanged. Reference rows offer editing, deletion and state undo without
Complete, Clarify or Brief. Use the editor to return it to Inbox or Next if it
becomes actionable. Filing preserves its identity, text, links and other fields,
and uses the same offline queue, version checks and conflict recovery as edits.

Waiting and deferred records remain visible in All statuses. **Ready for review**
shows waiting records whose review cue has arrived and deferred records whose
start has arrived. This is evaluated at local midnight for calendar dates, or
at the stored instant for timed values. Refresh, reopen, focus the app, or change
a filter to update the view, including offline. An idle page has no timer or
background notification. Review and choose Next, a new date, or completion;
the clock never silently changes status, deadlines or planned days.

Undated waiting work stays visible in the Waiting filter and weekly reviews.
It does not become Ready for review or enter a daily review solely because it is
waiting; an independent deadline or planned day can still include it. Capture,
editing and clarification all allow a dependency without a follow-up date (#72).
Existing review dates remain intact unless explicitly edited. To remove a cue,
clear it in the ordinary item editor; a blank clarification date keeps it.

Invalid state changes explain the missing information and keep the editor and
draft. The API validates the resulting record inside the existing atomic commit,
so a partial update cannot evade the same rules. Any future rules/AI client must
submit ordinary versioned operations through this boundary.

**Undo state change** restores the latest workflow snapshot (status, dependency,
start and review cue). It survives reload and sync, and uses the observed record
version, so another device's edits produce the existing conflict flow. Unrelated
text, project, list, planned-day and deadline edits are not undone. Undo is one
level and can reverse the immediately preceding undo; it is not an edit-history
browser. Completion/reopening retains waiting/deferred metadata. Historic records
with incomplete workflow metadata need an explicit repair before returning to
waiting/deferred.

## Date meanings and wire values

| Purpose | Calendar field | Timed field | Meaning |
| --- | --- | --- | --- |
| Deadline | `dueDate` | `dueDateUtc` | When the work is due. |
| Planned day | `plannedDay` | None | Which day view includes the action; not a deadline. |
| Deferred start | `startDate` | `startDateUtc` | When deferred work becomes ready for review. |
| Review cue | `reviewDate` | `reviewDateUtc` | When to check a waiting dependency. |

Calendar values are validated `YYYY-MM-DD` strings (years 0001–9999), never
converted to midnight UTC. A phone in Honolulu and a laptop in Auckland display
the same chosen date. Use `null` to clear a date. For each purpose, choose a
calendar date or timed value, not both. Changing representations requires clearing
the other value in the same save.

The API retains the existing strict UTC ISO timestamp contract (seconds, optional
milliseconds, and `Z`). Review/start time inputs accept ISO timestamps with `Z`
or explicit numeric offsets and normalize new edits to UTC. For example,
`2026-11-01T01:30:00-04:00` and `2026-11-01T01:30:00-05:00` identify the two
occurrences of the repeated US Eastern hour. The deadline time control uses the
browser's local zone: nonexistent spring-forward times are rejected; a repeated
fall-back hour uses its first occurrence, as its label states. A caller needing
the second occurrence can submit its explicit UTC instant. Timed cues are fixed
instants, not recurring zone rules. Unchanged timestamps are omitted from editor
patches, preserving precision and the original instant even in a repeated hour.

## Compatibility and rollout

No migration, backfill, partition change or reset is needed. Calendar fields and
server-derived undo metadata are additive; original capture/source and stable
IDs are unchanged. The existing migration tool preserves custom statuses and
date values verbatim, including historic unparseable dates. Its backup/rollback
path is unchanged and covered by a workflow preservation test. Unrelated edits
preserve those values; an explicit workflow change must supply valid required
metadata. Derived `nextAction` is reconciled on the next live item write.

Deploy the API before the workflow-capable shell (**v8** or later) and keep its support while clients have pending
operations. v3–v9 shell upgrade checks retain exact queued operations, drafts and
account caches. An old queued incomplete waiting/deferred transition can now be
rejected: it stays recoverable at the queue head, and is never silently repaired
or discarded. Copy/export its proposal before removing the rejected save and
re-entering it with a dependency/date. Previously acknowledged operations retain
their original durable receipts. Do not clear storage or rewrite operation IDs
to bypass a rejected transition.

## Verification

Automated coverage uses production API handlers with the existing in-memory
Cosmos substitute and Playwright on Windows. It covers invalid/atomic transitions,
completion/reopening/undo (including undo back to completed), derived flags,
stale-version conflicts, date validation, explicit DST offsets, spring-forward
gaps, offline reload/reconnect and Honolulu/Auckland browser contexts. The existing
project/day, migration, security, account isolation, responsive layout and shell
upgrade checks are retained. Real SWA/Cosmos, physical phone keyboards and screen
reader verification remain unverified release gates.

Local evidence on October 2, 2026: Windows, Node 26.7.0, Edge 154.0.4258.48.
Run from `api/` with `PLAYWRIGHT_CHANNEL=msedge`: `npm test`.
All 58 tests passed, none skipped. One offline test initially raced shell
installation; shared setup now waits for the app's offline-ready signal before
disconnecting, and the full suite passed after that correction.
The workflow editor was visually inspected at
[390px](design/workflow-390.png) and [1440px](design/workflow-1440.png).
This branch incorporates main's project/day PR #31 (`84f49c6`); its shared
forms, calendar validator and cache/module versions were reconciled before testing.

CI follow-up: reproduced the reopen/reload race using Chromium 153.0.8010.12.
The workflow test now waits for the committed Reopen result before reloading.
Merged PR #32 (`36277d7`) supplies the shared sync helper that waits for persisted
cursor/queue state and matching rendered items, including a deliberately delayed
response consumer. Its PWA install flow is retained; the combined shell is v8.
All **66 tests pass** locally with Chromium after integration, including upgrades
from shells v3–v7. No test was skipped or assertion weakened.
