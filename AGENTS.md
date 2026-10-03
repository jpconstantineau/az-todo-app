# Agent instructions

These instructions apply throughout this repository. For coding work, use the
Ponytail approach below: understand the problem fully, then make the smallest
correct change that satisfies the request. Explicit user requirements take priority.

## Repository and design

- The client lives in `html/` and uses HTML, CSS, and native JavaScript ES modules. The API lives in
  `api/api/` and uses JavaScript ES modules, Azure Functions, and Cosmos DB.
- Before writing or changing UI, read [DESIGN.md](DESIGN.md) and use its colors,
  typography, spacing, and component guidance as the design reference. Apply it
  within the requested scope; do not turn a focused change into a full redesign.
- `DESIGN.md` was installed from the
  [HashiCorp design reference](https://getdesign.md/hashicorp/design-md) by running
  `npx getdesign@latest add hashicorp` at the repository root. Review the diff if
  reinstalling, since the command may replace local design customizations.
- Inspect the working tree before editing and preserve unrelated user changes.
- For browser saves, sync, account changes, navigation/focus, offline shell work,
  related tests, or CI diagnosis, read and apply the repository's
  [az-todo-ci skill](.agents/skills/az-todo-ci/SKILL.md).

## Understand before simplifying

Read the task and affected code, then trace the actual flow end to end before
choosing a solution. For a bug, search for every caller of the function you plan
to change. Fix the shared root cause when appropriate, and check sibling paths;
a small patch that only hides the reported symptom is unfinished work.

## Choose the first sufficient solution

1. Check whether the proposed work is needed now. Skip speculative features and
   explain the omission briefly; never drop an explicit requirement.
2. Search for an existing helper, type, or pattern in this repository and reuse it.
3. Prefer a standard-library solution.
4. Prefer native platform features, such as HTML controls, CSS, and database
   constraints, over custom application code.
5. Reuse an installed dependency before considering a new one. Do not add a
   dependency for something a few clear lines already solve.
6. Use a one-line solution when it is correct and readable.
7. Otherwise, write only the minimum code needed to complete the task.

## Keep changes small and maintainable

- Avoid unrequested abstractions, single-use factories, unnecessary configuration,
  boilerplate, and scaffolding for hypothetical future needs.
- Prefer deletion, familiar patterns, and a small number of changed files. Do not
  sacrifice correctness or readability merely to reduce the line count.
- When equally simple options exist, choose the one that handles edge cases.
- Resolve routine choices using the available context and keep moving. A simpler
  implementation must still fulfill the requested behavior.
- If a deliberate shortcut has a real limit, add a `ponytail:` comment identifying
  that limit and when to replace it, for example:
  `// ponytail: linear scan; use an index if measured list size makes it slow.`

## Preserve correctness and verify

- Never remove trust-boundary validation, security protections, error handling
  that prevents data loss, accessibility basics, or explicitly requested behavior
  in the name of simplicity.
- For hardware-related work, preserve necessary calibration and tuning controls.
- For non-trivial logic, add or update at least one small runnable check that
  fails when the behavior breaks. Reuse the existing test setup, or use a small
  Node.js assertion/test script when no test setup exists. Do not introduce a
  test framework or elaborate fixtures solely for a small change.
- Trivial one-line and documentation-only changes do not need new tests. Run the
  checks appropriate to the change and report what was verified and any limits.

## Modes and communication

Use **full** mode by default for coding work. The chosen mode persists through
the session until changed. Accept `/ponytail lite`, `/ponytail full`, or
`/ponytail ultra` as mode switches:

- **lite:** Complete the request and briefly mention a simpler alternative.
- **full:** Follow the solution order above and keep the implementation focused.
- **ultra:** Question speculative additions more aggressively and prefer deletion
  where it still satisfies the request. Explicit requirements still take priority.

If the user says `stop ponytail` or `normal mode`, stop applying the optional
Ponytail mode for that session. Keep the repository/design guidance and normal
correctness and verification practices. These coding modes do not govern unrelated
prose, translation, or general-knowledge tasks.

Deliver the change first, then keep the handoff brief: what changed, what was
checked, and any deliberate omission with the condition for adding it later.
Provide fuller explanations whenever the user requests them.

