# Active work and WIP policy

Do keeps execution state separate from task readiness and planning. An item can be **Started**, **Paused**, or **Blocked** without changing its canonical `status`, planned day, deadline, memberships, project, recurrence identity, or item ID. Returning an item to ready removes only its active-work entry.

Each workspace has at most one `executionPolicy` record whose ID equals the workspace ID. The user chooses an integer WIP limit from 1 through 20. A policy holds at most 40 unique canonical item IDs:

- Started work consumes one WIP slot.
- Paused work remains visible and consumes no slot.
- Blocked work remains incomplete, needs a 1–500 character reason and review date, and consumes one slot.
- Starting or resuming above the limit requires pausing counted work in the same save or choosing the visible override action.

Active-work updates use the normal versioned v1 record, IndexedDB projection, outbox, receipts, change feed, and conflict surface. Offline changes render immediately and survive reload. Competing devices update the same workspace policy version, so one save commits and the other remains a durable conflict. Retrying recalculates against the latest limit and entries; using server active work discards only the failed active-work save.

Completion, dropping, reference conversion, deletion, review decisions, clarification terminal decisions, and recurring completion or skip remove an active entry in the same queued operation. If another device makes an item ineligible before its policy entry can be cleaned up, Do keeps it visible and counted with a review warning until the user removes it explicitly.

Daily reviews include blocked work when its review date arrives. Weekly reviews include all incomplete blocked work and show its reason, review date, WIP effect, and override label.
