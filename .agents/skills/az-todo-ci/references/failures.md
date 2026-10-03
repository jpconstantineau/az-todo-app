# CI failure review

Reviewed 2026-10-03: the GitHub Actions API returned 26 failed runs across
18 distinct head commits (25 Task flow tests runs, one Azure deployment run).
Inspected all 26 failed-job logs, including both push and PR runs, and compared
the relevant fix diffs. These are retained failed conclusions, not a claim about
deleted logs or earlier attempts of runs whose latest conclusion is success.
Application baseline: main at `819e6e2`; the editor-dismissal follow-up at
`6835e27` was also inspected. Links are historical evidence, not current status.

## Repeated causes and implemented fixes

| Failed run and symptom | Fix inspected | Reusable check |
| --- | --- | --- |
| [36962085747](https://github.com/jpconstantineau/az-todo-app/actions/runs/36962085747): inbox reload saw four queued changes instead of five. [36975046820](https://github.com/jpconstantineau/az-todo-app/actions/runs/36975046820): workflow state disappeared across reload. | [0796e88](https://github.com/jpconstantineau/az-todo-app/commit/0796e88), [dd8ca69](https://github.com/jpconstantineau/az-todo-app/commit/dd8ca69) wait for committed save/reopen results before reload. | Await the durable result of the current edit. |
| [36974538565](https://github.com/jpconstantineau/az-todo-app/actions/runs/36974538565): second browser rendered zero of two pulled items. [37051596097](https://github.com/jpconstantineau/az-todo-app/actions/runs/37051596097): status-filter test saw zero of four items. | [973c361](https://github.com/jpconstantineau/az-todo-app/commit/973c361) adds `waitForBrowser`, applied watermark/outbox/render checks and a delayed response-consumer scenario; [10db7fe](https://github.com/jpconstantineau/az-todo-app/commit/10db7fe) waits for pulled records. | Headers or a previous idle label do not prove application of a pull. |
| [37022966378](https://github.com/jpconstantineau/az-todo-app/actions/runs/37022966378): brief focus was null and the expected one-entry outbox never appeared. | [857ff6c](https://github.com/jpconstantineau/az-todo-app/commit/857ff6c) waits for the specific revision's status and acknowledgement before the next offline decision, and for asynchronous focus. | Tie confirmation to a revision/operation, not just a global label. |
| [37128304553](https://github.com/jpconstantineau/az-todo-app/actions/runs/37128304553): recovery lacked the latest correction. [37094873530](https://github.com/jpconstantineau/az-todo-app/actions/runs/37094873530): deletion error text was still empty. | [90a2231](https://github.com/jpconstantineau/az-todo-app/commit/90a2231) persists the correction and waits for the current failed save; [457ed5c](https://github.com/jpconstantineau/az-todo-app/commit/457ed5c) waits for deletion errors, removal, and focus. | Await the new failure/result, including when an old error panel is already visible. |
| [36975264140](https://github.com/jpconstantineau/az-todo-app/actions/runs/36975264140): visibility/focus assertions raced navigation. [37091471506](https://github.com/jpconstantineau/az-todo-app/actions/runs/37091471506): Preferences was hidden. [37150357240](https://github.com/jpconstantineau/az-todo-app/actions/runs/37150357240): keyboard could not reach Brief Insurance. | [b5b5b9a](https://github.com/jpconstantineau/az-todo-app/commit/b5b5b9a) uses applied navigation and focus waits; [c381785](https://github.com/jpconstantineau/az-todo-app/commit/c381785) waits for responsive collapse; [986f254](https://github.com/jpconstantineau/az-todo-app/commit/986f254) waits for visible summaries before keyboard traversal. | Respect hashchange, responsive disclosure, and native focus timing. |
| [37131139985](https://github.com/jpconstantineau/az-todo-app/actions/runs/37131139985): export control stayed hidden during consecutive account changes. [37151571189](https://github.com/jpconstantineau/az-todo-app/actions/runs/37151571189): capture permission/account-switch wait timed out. | [3916e62](https://github.com/jpconstantineau/az-todo-app/commit/3916e62) waits for Bob's pull and restored controls; [ded85bb](https://github.com/jpconstantineau/az-todo-app/commit/ded85bb) removes an unnecessary listener in a sibling scenario. [6835e27](https://github.com/jpconstantineau/az-todo-app/commit/6835e27) waits for startup sync before switching the capture-test account. | Finish the relevant account transition; keep synchronization scoped to the scenario. |
| [36979649600](https://github.com/jpconstantineau/az-todo-app/actions/runs/36979649600): upgrade unexpectedly drained the pending outbox. [37011620959](https://github.com/jpconstantineau/az-todo-app/actions/runs/37011620959): upgraded shell readiness timed out. | [fb43afb](https://github.com/jpconstantineau/az-todo-app/commit/fb43afb) injects the outage at the server and checks the original receipt; [7fd0c54](https://github.com/jpconstantineau/az-todo-app/commit/7fd0c54) waits for worker activation before reopening. | Fault injection must survive worker changes; closing a tab does not synchronously release its worker client. |

The repeated theme is **observing the start of an operation as though it were
its completion**. Existing helpers and operation-specific predicates address
this more directly than broad timeout increases. This is an inference from the
logs and fixes, not a claim that every timeout is a test race.

## Different causes and limits

- **Real application focus defect:** [36979424297](https://github.com/jpconstantineau/az-todo-app/actions/runs/36979424297)
  timed out restoring dialog focus. [6673fcf](https://github.com/jpconstantineau/az-todo-app/commit/6673fcf)
  also changes production `html/inbox.js`: delayed close handlers preserve a
  newer valid focus choice. Its regression forces consecutive closes in one
  task. Waiting alone would not repair that defect.
- **Changed product behavior:** [37151539900](https://github.com/jpconstantineau/az-todo-app/actions/runs/37151539900)
  and its PR counterpart expected a dismissed editor to reopen automatically.
  [6835e27](https://github.com/jpconstantineau/az-todo-app/commit/6835e27) updates
  the design test to await persisted dismissal, assert the editor stays closed,
  and explicitly resume. The same push run also had an editor-dismissal
  assertion failure; no direct change to that test was found in the follow-up,
  so its root cause is not established here.
- **Other observations without a verified fix mapping:**
  [37129174755](https://github.com/jpconstantineau/az-todo-app/actions/runs/37129174755)
  lacked unversioned `/inbox-store.js` in the observed cache, and
  [37149584683](https://github.com/jpconstantineau/az-todo-app/actions/runs/37149584683)
  timed out clicking hidden `#newList`. Do not label these resolved solely from
  a later green run. Shell integration commits such as
  [8ff03af](https://github.com/jpconstantineau/az-todo-app/commit/8ff03af) and
  [5682209](https://github.com/jpconstantineau/az-todo-app/commit/5682209) demonstrate
  coordinated version/contract updates, but are not proven fixes for those runs.
- **Deployment capacity:** [36975310515](https://github.com/jpconstantineau/az-todo-app/actions/runs/36975310515)
  completed the Node 22 API build, then Azure rejected upload because the Static
  Web App already had its maximum staging environments. The earlier Oryx
  language-detection message was followed by successful static-asset handling.
  No code fix or environment cleanup was verified for that failure. Do not
  prescribe runtime changes or delete environments based on that warning.

## Validation choices

The skill reuses existing helpers and test commands; it adds no timing wrapper,
dependency, workflow, or blanket serial execution. Runtime alignment to Node 22
is taken from the current workflow/package configuration, not inferred as the
cause of the historical Azure failure. Keep these historical findings separate
from future run diagnoses and revise the skill when new evidence warrants it.
