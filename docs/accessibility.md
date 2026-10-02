# Accessibility and keyboard behavior

Issue #16 remains open for the full pilot flow and real assistive-technology
verification. This change covers the current capture, editing, clarification,
list/project/defaults, review-dialog focus, navigation and device-export controls.

## Focus and announcements

- Use Tab/Shift+Tab to reach native links, buttons and labelled form controls;
  Enter/Space activates the appropriate control. The skip link reaches the
  current view (or Sign in), and Ctrl/Command+Enter saves a capture.
- Sync and other-tab refreshes retain the focused task action. Controls are
  matched by record identity and action, including when a title changes or two
  tasks have the same title. Complete/Reopen keeps focus on the same control.
  When a filter, move or deletion removes that control, focus returns to the
  visible view heading. Refreshes do not move focus out of an open modal.
- Editors, defaults and clarification return to the opening control on Save,
  Close/Stop or Escape, even if it was re-rendered while the dialog was open.
  If that control no longer exists in the current view, the view is the fallback.
  Dialogs restored after reload use that fallback; account changes cannot return
  focus to a previous account's action.
  Delayed close events retain valid focus from a later interaction, including
  when another dialog has already opened and closed.
- Clarification focuses each question as it advances. Invalid acceptance keeps
  focus on the initiating control and exposes an alert. Answers remain editable.
- Draft and sync live regions change only when their message changes. Repeated
  typing or unchanged refreshes no longer replace identical announcement text.
  A verified account name is refreshed without briefly announcing a neutral
  label on every sync; failed/mismatched profiles still fall back to the neutral
  label, and logout/account changes still clear identity.
- State is expressed in text, including pending/confirmed/failed saves; work has
  no forced timer. The existing 44px control targets, visible focus outlines,
  native modal behavior, responsive layout and light/dark colors are retained.

Shell v14 includes these changes, clarification from v11 and reviews from v12.
Deploy the compatible API first. As before, updates wait for old tabs to close;
no forced activation, storage reset or outbox rewrite is introduced.

## Reproducible automated checks

From `api/` with Node 24+ and Playwright Chromium installed, run `npm test`.
Use `PLAYWRIGHT_CHANNEL=msedge` for installed Edge instead. Tests run production
client code with real browser IndexedDB; the API storage is an in-memory fixture.

| Check | Evidence |
| --- | --- |
| Duplicate titles, renamed tasks, background refresh, Complete/Reopen, filtered-away row | `accessibility.test.mjs` checks the actual active element after keyboard actions. |
| Save/Escape, list/project/defaults/clarification return focus, invalid clarification, export | `accessibility.test.mjs` checks native dialogs, question focus and a downloaded JSON export. |
| Unchanged announcements vs new saves | `accessibility.test.mjs` observes live-region DOM mutations; actual spoken output requires the manual checks below. |
| Account rename, timeout, delayed responses, switching and logout | `account-sync.test.mjs` retains identity/isolation coverage. |
| 320px reflow, enlarged text, shortened viewport, dialog containment and touch targets | Existing `navigation.test.mjs` and `design.test.mjs`. |
| Text and focus contrast in both themes | `design.test.mjs`: at least 4.5:1 text and 3:1 control borders/focus on tested surface tokens. |
| Offline reopen and shell update with pending saves/drafts | Existing `inbox.test.mjs` and `pwa.test.mjs`. |

Local verification date: October 2, 2026 (America/Regina), Windows, Node 26.7.0.
The PR records the tested commit, browser version and full-suite result. These
automated checks do not certify spoken announcements, physical touch targets,
real browser zoom or phone keyboard behavior.

## Remaining release evidence

Keep #16/#17 open until a desktop screen-reader run and iPhone VoiceOver or
Android TalkBack run are recorded. For each, record commit/deployed environment,
OS/browser/assistive-technology versions, steps, expected/actual results and any
defect. Include:

1. Capture, save, navigate, edit, close/reopen, clarify (accept/edit/skip/stop),
   and export with keyboard or screen-reader navigation. Verify useful names,
   readable originals, correct question announcements and no keyboard trap.
2. Type a long draft while another client syncs. Confirm no repeated unchanged
   announcements, focus loss or overwritten input; new errors remain announced.
3. Edit a renamed task, use two identical titles, complete a filtered task, and
   switch views/accounts with a dialog open. Confirm the documented return focus.
4. Test 200% browser zoom and 320 CSS pixels; on a physical phone show its software
   keyboard and confirm Save remains reachable. Check reduced-motion preference
   and forced colors. The current flows introduce no animated transitions.
5. Verify the full daily/weekly review flow with assistive technology, then extend
   to accepted briefs when available. Review-dialog focus is covered here; full
   spoken-flow accessibility is not established by this change.
