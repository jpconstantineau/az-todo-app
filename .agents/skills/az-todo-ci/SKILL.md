---
name: az-todo-ci
description: Prevent recurring az-todo-app CI regressions when implementing browser saves, sync, account changes, navigation, focus, offline shell updates, or their tests. Also use when diagnosing this repository's CI failures.
---

# Check the operation that actually finished

This repository repeatedly passed local checks while CI observed an earlier
save, render, account, or worker state. Apply the relevant checks below while
implementing the change, then verify the integrated result. Paths below are
relative to the repository root. Read [the failure review](references/failures.md)
when diagnosing a failure or checking why a rule exists.

## Saves, sync, and account changes

- Before reload, browser termination, going offline, or switching accounts,
  wait for the specific draft, record, revision, or queued operation to reach
  its required state. A completed click or fill only dispatched the action.
- Reuse `waitForBrowser` from `api/test/browser-wait.mjs` for asynchronous
  IndexedDB predicates. Use locator waits or synchronous `page.waitForFunction`
  predicates for DOM state. The helper explicitly awaits each evaluation and
  retries false results; avoid copying an asynchronous wait pattern blindly.
- Response headers and an already-visible confirmation/recovery message do
  not identify the current operation. Register response/event listeners before
  triggering it, then wait for its application: the expected record/revision,
  relevant outbox acknowledgement, and rendered result where needed. See
  `sync` in `account-sync.test.mjs` and `confirmedRevision` in `briefs.test.mjs`
  under `api/test/`.
- A changed stored account ID does not mean its initial pull and controls are
  ready. Let that transition finish before simulating another account change
  or sign-out. Preserve assertions that old-account data and downloads vanish.
- For storage failures, persist the intended pre-failure draft first, inject
  the failure at the intended write, and await that failure's result. An old
  recovery panel can already be visible with stale text. Check the new recovery
  content and that the failed operation did not enter the queue.

## Navigation, disclosures, and focus

- Reuse `showView` and `clickControl` in `api/test/navigation-helper.mjs` to
  await applied navigation and open native disclosures through real clicks.
  After viewport changes, await the responsive menu state before opening it.
  `includeHidden` finds a control; it does not make it actionable.
- In keyboard tests, wait until the containing view and menu summary are
  visible before focusing them. Keep actual Tab/Enter/Escape traversal and
  assert the resulting focus; do not substitute forced clicks or extra Tab
  iterations for readiness.
- Native dialog close events can arrive after a later interaction. Wait for
  the promised focus result in tests, but fix production code if an old callback
  steals a newer valid focus choice. Exercise that ordering explicitly.
- When changing intended behavior, update sibling browser expectations too.
  For example, a deliberately dismissed editor must remain closed after reload;
  a test expecting automatic reopening must instead exercise explicit resume.

## Offline shell and worker updates

- For failures that must survive service-worker activation, use the server-side
  `rejectOperations` hook in `api/test/harness.mjs`. Browser request interception
  alone did not reliably hold operations pending through worker changes.
- Assert a real pending operation exists before the upgrade; preserve its exact
  payload, operation ID, and draft through failed install, successful activation,
  and offline reload. After removing the fault, check the original receipt and
  a single stored result, not merely an empty outbox.
- Register the worker event before requesting an update. After closing the old
  tab, wait on the new worker's activated state before reopening; immediate
  reopening can attach to the old worker and prevent activation. Follow the
  existing upgrade scenario in `api/test/inbox.test.mjs`. Keep activation natural.
- When changing cached assets or integrating another UI branch, reconcile the
  worker cache name/allowlist, HTML entry URLs, module import versions, `pwa.js`
  handshake, and matching contract/cache/upgrade tests. Choose a fresh version
  relative to integrated main and retain upgrade coverage for the prior shell.
  Documentation-only changes do not need a shell bump.

## Verify and classify

Read `.github/workflows/test.yml` and `api/package.json` for the current runtime
and commands. At this review, CI uses Node 22, `npm ci` in `api/`, and Playwright
Chromium installed with `npx playwright install --with-deps chromium` on Linux.
Run focused tests from `api/`, for example:

```sh
node --experimental-test-module-mocks --test test/browser-wait.test.mjs test/account-sync.test.mjs
```

For application/test changes, follow focused checks with `npm test` in `api/`
on the final integrated tree, preserving CI's normal concurrency. If reproducing
an ordering bug, inject a controlled delay/failure using the existing harness
and assert the invariant; sleeping longer, serializing the suite, or rerunning
until green does not establish a fix. Documentation-only edits need link/content
validation rather than a new application test.

Read the failing step and terminal error before assigning a cause. Separate
test synchronization, genuine application defects, stale expectations after
integration, and deployment capacity. Azure's historical staging-environment
limit occurred after the API build succeeded; the earlier static HTML Oryx
language-detection warning was not the fatal cause. Report the capacity issue
and resolve it only within the authorized deployment scope.
