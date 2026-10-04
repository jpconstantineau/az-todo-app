# Projects and planned days (#7)

Choose **New project** in Your work and describe its title and desired outcome.
Save it on device, then open an action's **Task details** to assign that project
and optionally a planned day. These controls also appear in capture options.
Projects, days and areas are optional; groceries and quick captures need none.
Areas remain the existing optional action tags, with no new taxonomy to set up.

The **View** selector provides Inbox (unprocessed captures across lists), No list,
each project, and Planned day with a calendar picker. Project views show the
outcome and an edit button. Status filtering still applies. An action without a list can appear in
No list, its project and its planned day. Unprocessed actions also appear in Inbox.
All views edit the same action, so notes, completion, reopening and list moves
stay consistent. Assigning a project does not remove list membership or change
original capture/source data. The device
export contains one current record per action plus its separate project record;
outbox/history entries are operations, not additional actions.

Planned day is a calendar date, independent of device time zone. A deadline is
still the separately labelled local date/time converted to UTC. For example,
planning Milk for October 5 keeps October 5 in Honolulu and Auckland even when
its timed deadline falls on different local dates in those cities.

Project creation, edits and assignments use the existing durable drafts/outbox,
expected versions, receipts, conflict comparison and explicit resolution. View
and selected-day preferences are saved per account. A missing project selection
is retained for correction instead of silently clearing the intended assignment.
Projects may be created offline and assigned before reconnecting: the queue sends
their creation before the action update. No IndexedDB or Cosmos migration is
needed, and no current data is rewritten. Legacy migration fixtures verify that
linking an imported action preserves its areas, custom status, deadline and text.

## Project lifecycle (#79)

In **Edit project**, choose **Active**, **Someday / on hold**, or **Completed**.
Choose Active again to reactivate the same project. Existing projects without a
status remain active; new projects default to active. The View selector and Lists
outline label project states, including completed outcomes, so they remain retrievable.

Status changes preserve the project identity, outcome, notes, linked actions and
history. Unfinished actions are deliberately left unchanged: they remain in their
usual views and reviews. Edit those actions individually to complete, defer, drop
or move them. Project status never silently changes an action's status.

Weekly reviews include active projects. **Review someday projects** starts an
optional review of incubated outcomes. Completed projects are excluded from new
reviews; existing review inventories and decision history stay intact. The review
editor supports the same lifecycle changes without losing the review position.

Lifecycle edits use the normal offline draft/outbox, version checks, conflict
comparison and editor undo. `project-lifecycle.test.mjs` covers legacy defaults,
validation, reactivation, unchanged actions/history, conflicts and offline reloads.

## Verification

Run `npm test` from `api/` with Node 24+ and Playwright Chromium. New coverage
checks atomic project/link writes, repeat delivery, owner boundaries, invalid
outcomes/calendar dates, linked-project deletion, concurrent deletion/linking,
offline creation and editor-draft recovery, view persistence, canonical export
and independent browser contexts in Honolulu/Auckland. Existing capture,
security, migration, conflicts and shell-upgrade checks remain in the suite.

Automated browser evidence was recorded on October 2, 2026, Windows, Node 26.7.0
and Playwright Chromium 153.0.8010.12. At implementation commit `ac02173`, all
52 tests passed with none skipped, including merged PR #29 and upgrades from
shell versions 3, 4 and 5. Layout checks cover 320/390/768/1440/2560 CSS pixels.
Set `PROJECT_SCREENSHOTS=1` when running the suite to refresh the
[390px day view](design/projects-day-390.png) and
[1440px project view](design/projects-1440.png). The controls reuse the design
reference's existing native form and card styling. Projects and planned-day
filters now live in [Your Work](navigation.md). Physical phones, screen readers and real SWA/Cosmos verification remain
unverified release gates, rather than claims made by these in-memory tests.
