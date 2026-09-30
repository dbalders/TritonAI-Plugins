# Microsoft 365 plugin

Trusted server-side TritonAI Harness provider for bounded Microsoft 365 mail, calendar, chat, and
OneDrive file access. Mail, calendar, chat, and OneDrive file reads are enabled by default. Draft
creation, mail organization, calendar writes, chat send, and OneDrive file writes are separate opt-in
capabilities.

## Capability and authorization surface

| Capability          | Access  | Delegated scope       | Fixed actions                                 |
| ------------------- | ------- | --------------------- | --------------------------------------------- |
| `mail.read`         | Default | `Mail.Read`           | Search and read messages and attachments      |
| `mail.draft.create` | Opt-in  | `Mail.ReadWrite`      | Create an unsent draft with file attachments  |
| `mail.organize`     | Opt-in  | `Mail.ReadWrite`      | Create folders and move/archive messages      |
| `calendar.read`     | Default | `Calendars.Read`      | Read calendar events and attachments          |
| `calendar.write`    | Opt-in  | `Calendars.ReadWrite` | Create or edit an event                       |
| `chat.read`         | Default | `Chat.Read`           | List chats and read bounded message history   |
| `chat.write`        | Opt-in  | `Chat.ReadWrite`      | Send plain text to an existing chat           |
| `files.read`        | Default | `Files.Read`          | List, search, and read OneDrive files         |
| `files.write`       | Opt-in  | `Files.ReadWrite`     | Create folders/files, replace content, rename |

The provider never requests `Mail.Send`, application permissions, `.default`, or a client secret.
It exposes no generic Graph request, raw URL, arbitrary OData, mail send/delete, event delete,
invitation response, chat creation, message edit/delete, or OneDrive delete, move, copy, share, or
permission surface. Entra can return additive Graph scopes already consented for the same public
client; those never become Harness capabilities.
Draft creation and mail organization remain separate product capabilities even though both use
`Mail.ReadWrite`; selecting either one never enables the other.

`chat.write` deliberately uses the tenant's already-approved `Chat.ReadWrite` delegated scope rather
than introducing a new `ChatMessage.Send` approval. The capability and provider still expose only
the fixed send-to-existing-chat action; the additional delegated authority has no generic endpoint
or tool through which it can be exercised.

`files.read` and `files.write` address only the signed-in user's OneDrive (`/me/drive`). Microsoft's
`Files.ReadWrite` scope also authorizes deleting, moving, and sharing any file the user owns; this
package exposes only the fixed folder-create, new-file upload, content-replace, and rename actions.
New-file uploads use `@microsoft.graph.conflictBehavior` `fail` or `rename` and never replace an
existing file; replacing content requires the exact item ID and the separate content-update tool.
`files.write` does not enable the `files.read` tools.

The fixed endpoints follow the Microsoft Graph contracts for [reading a message](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0),
[creating a draft message](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0),
[listing mail folders](https://learn.microsoft.com/en-us/graph/api/user-list-mailfolders?view=graph-rest-1.0),
[creating a mail folder](https://learn.microsoft.com/en-us/graph/api/user-post-mailfolders?view=graph-rest-1.0),
[moving or archiving a message](https://learn.microsoft.com/en-us/graph/api/message-move?view=graph-rest-1.0),
[reading message attachments](https://learn.microsoft.com/en-us/graph/api/message-list-attachments?view=graph-rest-1.0),
[creating an event](https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0),
[reading an event](https://learn.microsoft.com/en-us/graph/api/event-get?view=graph-rest-1.0),
[reading event attachments](https://learn.microsoft.com/en-us/graph/api/event-list-attachments?view=graph-rest-1.0),
[updating an event](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0),
[listing chats](https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0),
[listing chat messages](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0),
[sending to an existing chat](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0),
[listing drive children](https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0),
[searching a drive](https://learn.microsoft.com/en-us/graph/api/driveitem-search?view=graph-rest-1.0),
[reading a drive item](https://learn.microsoft.com/en-us/graph/api/driveitem-get?view=graph-rest-1.0),
[downloading file content](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0),
[creating a folder](https://learn.microsoft.com/en-us/graph/api/driveitem-post-children?view=graph-rest-1.0),
[uploading or replacing file content](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0),
and [renaming a drive item](https://learn.microsoft.com/en-us/graph/api/driveitem-update?view=graph-rest-1.0).

Inputs, result counts, date ranges, response bytes, strings, OAuth scopes, and request duration are
bounded. Pagination links are neither followed nor returned; collection results expose only a
`hasMore` boolean. Draft bodies and chat messages use plain text; draft file contents use base64 as
required by Microsoft Graph.

Mail search and calendar-view requests only identification fields, previews, and attachment
presence. Exact message reads request a narrow field set and prefer a plain-text body. Every tool
result uses an explicit, byte-bounded projection. A projected body's `truncated` field reports
provider truncation, while `previewIsPartial` is true for every non-null Graph preview because the
upstream preview is semantically partial. Unknown Graph fields and server-provided continuation
URLs are not included. Chat messages with no returned content use `body: null`; oversized chat
collections retain the leading projected messages that fit and set `hasMore`.

Attachment list tools request metadata only so file bytes cannot make the list unusable. The matching
single-attachment tool temporarily preserves validated, bounded Graph `contentBytes` for a small
file or a fixed projection of an attached Outlook item under a sub-512 KiB serialized result
ceiling. Reference attachments return metadata only. This compatibility path does not expose
arbitrary attachment fields or provide file-system delivery; attachment-file delivery requires a
separate Harness-owned surface.

OneDrive item tools return a fixed metadata projection whose `webUrl` must be on a
`*.sharepoint.com` host. The content read tool accepts files of at most 256 KiB. It reads the item's
short-lived pre-authenticated download URL, validates that it is an HTTPS `*.sharepoint.com` URL,
downloads it without the Graph access token, and never returns the URL. Valid UTF-8 content that
fits the result ceiling is returned as text; anything else is returned as base64. Uploads accept at
most 4 MiB of decoded UTF-8 text or base64 content and return only an item receipt.

Version 1.1.1 removes the legacy raw-response compatibility field. Callers must use the normalized
top-level projection fields documented above.

## Provider entrypoint and configuration

The reviewed `dist/index.js` entrypoint exports the exact package `manifest` and a synchronous
`createIntegrationProvider({ secrets, configuration })` factory. Harness supplies only this
package's secret-store facade and configuration slice. The plugin accepts exactly a `clientId` and
`tenantId` string and rejects missing, extra, inherited, or malformed fields without echoing
configuration values.

The private Harness build input is one object keyed by selected package ID:

```text
TRITONAI_PLUGIN_CONFIGURATION_JSON={"microsoft-365":{"clientId":"11111111-1111-4111-8111-111111111111","tenantId":"22222222-2222-4222-8222-222222222222"}}
```

Do not put deployment configuration in runtime settings, logs, or the public composition proof.

## Secret and lifecycle behavior

The provider receives the Harness package-scoped Effect secret store and uses only suffix `oauth`.
It persists a versioned refresh credential and the fixed scopes selected through manifest
capabilities, never an access token. Device poll redemption, refresh rotation, and disconnect
removal require Harness `beginCommit()` admission and use its commit-tail signal. Any admitted
uncertainty yields error status and zero capabilities until verified disconnect.

The provider never mutates credentials inside `invoke`. Immediately before invocation, the Harness
calls its generic `prepare()` lifecycle hook. The hook returns immediately when the in-memory access
token remains usable or no stored connection exists; otherwise refresh-token exchange, rotation,
and storage run through Harness commit admission. Harness capability availability is the authority
for tool disclosure and invocation. Every write invocation requires `writeApproved === true` and a
successful `beginCommit()` immediately before the fixed Graph mutation. The provider implements
`connect` and `disconnect` so Harness can recover or reset faulted write state.
