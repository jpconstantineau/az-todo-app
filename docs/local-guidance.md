# Optional local guidance (#11)

In Clarify, expand **Optional local guidance** for the outcome, next-action or
missing-information question. Availability is checked without creating a model
session. Choose **Suggest with local AI**, **Download model and suggest**, or
**Continue download and suggest** to start. Download progress, cancellation and
failures appear inside the panel. There is no automatic inference.

The separate preview is an **unaccepted AI suggestion**, rendered as plain text.
**Use as proposed answer** replaces the answer only when explicitly chosen and
journals it in the existing device draft. Edit it, save it as a proposal, accept
it, skip, or stop using the ordinary clarification controls. Only acceptance can
change task facts. The last question (next/waiting/deferred) remains manual with
the existing rules and required dates/dependency fields.

The model can make factual mistakes even when the output has valid structure.
Review every suggestion, especially inferred outcomes and missing information.
No model output becomes accepted facts automatically. Original input is unchanged.

## Availability and privacy

The implementation follows the [Chrome Prompt API documentation](https://developer.chrome.com/docs/ai/prompt-api)
(reviewed October 2, 2026). It feature-detects the global LanguageModel API and
uses matching text/English expectedInputs and expectedOutputs options for
availability and creation. Creation happens directly in a button click. English
is the supported suggestion language here; use manual clarification for other
languages. Phones and unsupported desktops keep the same questions, validation,
capture, editing and review workflows. Existing deterministic behavior needs no AI.

Only the current task's title, notes, original input, clarification answers and
current proposal enter the local prompt. No account ID, other records, secrets or
remote source content are supplied. There is no external AI service, cloud
inference, API key, polyfill or model execution in a service worker. Browser model
downloads may require network access and storage. After download, offline
inference depends on the browser retaining and supporting the model. Task storage
is separate: saved/accepted work continues to sync to the existing cloud account.

Each request owns a fresh session. Completion, failure, cancellation, typing,
advancing a question, closing/collapsing the panel, hiding the page, or account
change discards stale results and releases sessions. A late session creation is
also destroyed. Suggestions are ephemeral until copied into a proposal; reopening
never automatically restarts a download or inference. A model error cannot clear
the original or the answer. Invalid JSON, extra fields, empty text and oversized
responses are rejected before display/use; normal server validation remains in place.

## Persistence and deployment

No storage schema, server API, queue format or conflict behavior changes. Once
chosen, the suggestion follows the existing account-bound draft/outbox and
version-checked clarification path, including storage recovery and conflicts.
The v16 shell includes the new module and fresh module URLs throughout the graph,
so a v15 worker cannot mix cached old imports with the new UI. Existing safe
update/close-all-tabs behavior remains in force.

## Verification

Automated local checks on Windows 11 (build 26200) with Node 26.7.0 and Edge 154.0.4258.53:

- Mocked API absent/unavailable/availability failure: manual acceptance works.
- Matching language/modality options; creation requires the explicit button.
- Downloadable/downloading progress and cancellation, late initialization,
  rejected creation, inference failure and invalid output.
- Separate preview and explicit use; offline journal/reload/acceptance; no queue
  mutation from generation; released sessions and text-only markup rendering.
- Typing, skipping, closing and account switching reject delayed results.
- Responsive screenshots at 320, 390 and 1440 CSS pixels in light/dark themes.

Run from the repository root with PLAYWRIGHT_CHANNEL=msedge on Windows:

    node --experimental-test-module-mocks --test api/test/local-guidance.test.mjs
    node --experimental-test-module-mocks --test api/test/*.test.mjs

Set GUIDANCE_SCREENSHOTS=docs/design/local-guidance to regenerate the
[review screenshots](design/local-guidance/). Browser tests mock LanguageModel;
they do not prove Gemini Nano quality, real model download/offline behavior or
physical phone/screen-reader usability. An unmocked secure-localhost probe in
Chrome 154.0.8037.93 exposed LanguageModel but returned unavailable with the same
English text options; no model was downloaded. A real supported desktop with a downloaded
model and deployed two-account/Cosmos verification remain unverified release gates
under #11/#17. Template briefs belong to #12 and are not introduced here.
