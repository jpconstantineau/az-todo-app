# Reference disposition — issue #77

Reference reuses the existing status selector, clarification disposition and
task-row layout. The title remains the edit target. Reference rows keep Delete
and state undo; they omit Complete, Clarify and Brief. Status and pending/error
text retain the existing colors and accessible native controls from DESIGN.md.

The local harness uses production HTTP handlers, IndexedDB and service workers
with an in-memory Cosmos substitute. No production data is changed.

The reference regression covers offline filing in a list with custom defaults,
reload, keyboard opening, notes editing, original text/link preservation,
reference retrieval, next-action/Inbox/planned-day exclusion, daily and weekly
review exclusion despite an overdue deadline, reclassification and state undo.
The clarification API regression also accepts Reference through the direct
disposition shortcut, with repeat delivery and original capture preservation.

Automated layout checks found no horizontal overflow at 320, 390, 768 and 1440
CSS pixels. Screenshots show a focused editable title and an unsynced reference
save; the 390 and 1440 images were visually inspected. Physical touch devices
and screen readers were not tested for this change.

- [320px](reference/reference-320.png)
- [390px](reference/reference-390.png)
- [768px](reference/reference-768.png)
- [1440px](reference/reference-1440.png)

Reproduce the focused checks from the repository root with
`node --experimental-test-module-mocks --test api/test/reference.test.mjs api/test/clarification.test.mjs api/test/reviews.test.mjs`.
Set `PLAYWRIGHT_CHANNEL=msedge` to use installed Edge, and optionally set
`REFERENCE_SCREENSHOTS` to an output directory to regenerate the images.

The shell delivers the updated UI and worker handshake together. Deploy the
compatible API with the client. Existing saved review inventories remain frozen;
new sessions exclude reference material. No data migration is needed.
