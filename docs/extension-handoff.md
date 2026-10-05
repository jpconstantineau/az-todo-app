# TaskGem web handoff (#6)

The web half of #6 is available at `/handoff.html`. It previews one saved browser
capture and, on **Save to my inbox**, posts its unchanged v1 create operation to
the existing authenticated API. The extension retains ownership of the local
queue until the web page returns a matching committed server acknowledgement.
This is an explicit online handoff, not background or bidirectional sync.

**TaskGem integration is still required.** Its separately maintained extension
currently has a Hello World popup. This repository supplies the web receiver,
protocol and an unpacked MV3 test fixture, not a replacement TaskGem extension.
Keep #6 open until its capture UI, durable queue and deployed handoff are verified.

## User flow

1. TaskGem durably saves a capture and its immutable operation/item IDs under the
   previously verified account. Keyboard/context capture must not depend on this
   page being open. Closing its popup after confirmed local save must be safe.
2. The user asks TaskGem to import that capture. TaskGem creates a random ticket,
   stores its association with that capture, account, exact destination origin and
   newly opened tab ID, and opens the URL below. No content is in the URL.
3. The page shows the installed extension ID. **Preview saved capture** verifies
   the SWA account and asks that specific extension for the selected capture.
   There is no automatic connection, import, extension discovery or account move.
4. The page verifies the account again, then displays title, original text,
   selection, source title/URL and notes as text. A matched `/.auth/me` profile
   supplies the friendly account name when available. Profile failure does not
   replace the stable account ID used for all authorization and queue ownership.
5. **Save to my inbox** checks the account again and submits the exact operation.
   The server remains the authority for authentication, CSRF, account isolation,
   field validation, atomic writes and replay-safe receipts. No principal header
   or extension credential is accepted in place of the signed-in SWA session.
6. A matching committed receipt and one more account check allow acknowledgement
   to the extension. Only after persisting queue removal does TaskGem reply that
   it has acknowledged. The user can open the workspace and sync to see the item.

The preview is read-only to preserve retry identity. Edit after importing, using
the normal workspace. Hiding/leaving the page, canceling, changing its fragment,
or a failed request clears the preview and cancels outstanding client requests.
A request already sent may have committed: retry the same operation, never
invent a new ID to get around an uncertain response or conflict. A capture later
edited/deleted in the app is not overwritten/resurrected by replay of its create.

## Bridge contract

Use Chrome's native
[external messaging API](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#external-webpage)
with an exact extension ID. The page calls `chrome.runtime.sendMessage` and
receives the response only through that request's callback. It does not listen
to `window.postMessage`, accept messages from an opener/iframe, inject scripts or
fetch extension URLs. It requires a secure, top-level page; localhost is usable
for development. Requests use 15-second timeouts and explicit retries.

Open:

```text
https://todo.jpto.dev/handoff.html#extension=<32 letters a-p>&ticket=<32 lowercase hex characters>
```

Generate a cryptographically random 128-bit ticket for a user-initiated handoff.
Only these two fragment parameters are accepted; query parameters are rejected.
The ticket is a capability scoped to a specific tab/account/capture, not an auth
token. Keep account IDs, captures, source URLs and auth tokens out of handoff URLs.
The sign-in return URL contains only this path and fragment. A retired/expired
ticket must not authorize another capture. An unacknowledged capture can be given
a fresh ticket by an explicit extension action, retaining the same operation.

Configure TaskGem's `externally_connectable.matches` with the production HTTPS
origin (and explicit development origins only in development builds). Do not use
`<all_urls>` or accept arbitrary preview deployments. The fragment selects an
installed extension; it does not certify that extension's publisher. The page
shows its ID before connecting; TaskGem must open the page using its own runtime
ID. In all cases, the payload can only propose a single inbox create for review.

For **every** external request the extension must validate browser-provided
`sender.origin`, parsed `sender.url` origin and `/handoff.html` path, no query,
top frame (`frameId === 0`), and `sender.tab.id` matching the ticket's stored tab.
Reject extension/content-script callers (`sender.id`), missing/malformed sender
metadata, unknown tickets, unsupported schemas and mismatched accounts. Do not
trust a tab, origin or account assertion supplied inside a payload. The stored
capture account must already match the account verified by the web app; do not
rebind an old queue when another user signs in. Initial account connection and
any unassigned-capture recovery need an explicit TaskGem flow before delivery.

Preview request:

```json
{
  "protocol": "taskgem-handoff-v1",
  "type": "preview",
  "ticket": "<ticket>",
  "requestId": "<fresh UUID>",
  "accountId": "<verified SWA account ID>"
}
```

Reply with exactly those five fields plus `operation`:

```json
{
  "apiVersion": 1,
  "accountId": "<original account ID>",
  "operationId": "<stable ID generated before local save>",
  "mutations": [{
    "type": "item",
    "id": "<stable item ID>",
    "action": "create",
    "expectedVersion": 0,
    "fields": {
      "title": "Read the article",
      "description": "Compare the examples",
      "originalText": "Read the article with its examples.",
      "sourceTitle": "An article",
      "sourceUrl": "https://example.com/article",
      "selectedText": "Selected passage"
    }
  }]
}
```

All shown fields are required; additional fields are rejected. IDs contain 1–128
letters/digits/underscores/hyphens. Limits match v1: title 200, notes 4,000,
original 16,000, source title 2,000, selection 8,000, source URL 2,048 characters;
the entire operation is at most 64 KiB UTF-8. The server also enforces its 32 KiB
record limit, including metadata. Reject oversized captures without truncating
or deleting the local original. Source URLs must be HTTP(S) without credentials.
Other protocols require manual capture. Title/original must be nonblank; preserve
their exact whitespace. Status defaults to inbox. No other mutations, lists,
workflow attributes, client-supplied ownership fields or executable markup are
accepted by this bridge. Standard API validation still applies independently.

An acknowledgement request has the five envelope fields, type `acknowledge`, a
fresh request ID and this `receipt` field:

```json
{
  "apiVersion": 1,
  "accountId": "<original account ID>",
  "operationId": "<same stable operation ID>",
  "status": "committed",
  "sequence": 1,
  "itemId": "<same stable item ID>",
  "version": 1
}
```

The web page validates the full API receipt and exact captured fields before
sending this minimal acknowledgement. TaskGem must match its pending operation,
item/account IDs, committed status, version and positive integer sequence.
Persist queue removal/ticket retirement before replying with the five envelope
fields plus `acknowledged: true` (no `receipt` or `operation` in this reply).
All replies must echo protocol, type, ticket, request ID and account exactly.

Malformed messages, timeouts, unavailable extension, expired login, changed
account, offline state, storage errors and API conflicts must keep the extension
copy. A lost operation response can be retried unchanged: v1 returns the original
receipt. A lost extension reply after removal is also safe: the server has the
capture, and the extension must show its completed state rather than invent a
new create. A later tombstone does not invalidate the original acknowledgement.
Do not log capture text, source URLs, tickets or full auth payloads.

## Persistence and deployment

No storage schema, API endpoint, authentication policy or PWA shell migration is
needed. This page does not register a worker, cache responses, or create a second
web queue. Existing workers bypass the new page/modules. Offline/unsupported
browsers retain the normal app workflow; the extension queue provides handoff
durability. The page calls only same-origin APIs with credentials, `no-store`,
redirect rejection and existing request protection. No cloud inference is used.

## Verification

From `api/` on Node 22.x with Playwright Chromium installed:

```text
node --experimental-test-module-mocks --test test/handoff.test.mjs
npm test
```

The focused checks cover strict schemas/bounds, unsafe URLs/markup, explicit
preview/save, exact source preservation, duplicate submit, lost save response,
lost acknowledgement, logout/account changes, delayed messages, offline failure,
changed-content reuse, and replay after deletion. The real unpacked **test
fixture** verifies native external messaging and rejects another tab and path;
the other browser cases inject a controllable runtime for failure scenarios.
The fixture is not TaskGem and is not shipped in the web app. Its localhost
manifest is deliberately test-only. CI uses Playwright's bundled Chromium for
that case even when other tests select installed Edge.

Review screenshots: [320px light](design/handoff/handoff-light-320.png),
[390px dark](design/handoff/handoff-dark-390.png),
[1440px dark](design/handoff/handoff-dark-1440.png). Set `HANDOFF_SCREENSHOTS` to
`../docs/design/handoff` while running the focused check from `api/` to regenerate
320/390/1440px light/dark views. Existing DESIGN.md tokens, labels, native controls,
visible focus and live status/error regions are reused.

These checks use the in-memory Cosmos substitute. CI records the tested commit
and full-suite result. TaskGem's real popup/keyboard/context
capture, popup termination, real production extension IDs/origins, SWA login
return, deployed Cosmos, physical devices and assistive technology remain
unverified #6/#17 completion gates.
