# Active work and WIP policy

Do keeps execution state separate from task readiness and planning. An item can be **Started**, **Paused**, or **Blocked** without changing its canonical `status`, planned day, deadline, memberships, project, recurrence identity, or item ID. Returning an item to ready removes only its active-work entry.

Each workspace has at most one `executionPolicy` record whose ID equals the workspace ID. Preferences → Do → Active work holds the workspace settings; Do shows the counter and work lanes. The user explicitly chooses an integer WIP limit from 0 through 50; 0 means no limit. An absent policy still requires a choice before starting work. Entries use unique canonical item IDs and remain subject to the existing record and operation byte limits:

- Started work consumes one WIP slot.
- Paused work remains visible and consumes no slot.
- Blocked work remains incomplete, needs a 1–500 character reason and review date, and consumes one slot.
- Starting or resuming above a positive limit requires pausing counted work in the same save or choosing the visible override action.

Changing to zero always permits current work. Changing from zero to a positive limit, or lowering a positive limit, requires pausing or returning enough counted work first. Same-limit saves and increases preserve existing valid overrides.

Active-work updates use the normal versioned v1 record, IndexedDB projection, outbox, receipts, change feed, and conflict surface. Offline changes render immediately and survive reload. Competing devices update the same workspace policy version, so one save commits and the other remains a durable conflict. Retrying recalculates against the latest limit and entries; using server active work discards only the failed active-work save.

Completion, dropping, reference conversion, deletion, review decisions, clarification terminal decisions, and recurring completion or skip remove an active entry in the same queued operation. If another device makes an item ineligible before its policy entry can be cleaned up, Do keeps it visible and counted with a review warning until the user removes it explicitly.

Daily reviews include blocked work when its review date arrives. Weekly reviews include all incomplete blocked work and show its reason, review date, WIP effect, and override label.
