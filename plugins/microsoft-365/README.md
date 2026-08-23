# Microsoft 365 plugin

Trusted server-side TritonAI Harness provider for bounded Microsoft 365 mail, calendar, and chat
access. Mail and calendar reads are enabled by default. Draft creation, calendar writes, chat read,
and chat send are separate opt-in capabilities.

## Capability and authorization surface

| Capability          | Access  | Delegated scope       | Fixed actions                                |
| ------------------- | ------- | --------------------- | -------------------------------------------- |
| `mail.read`         | Default | `Mail.Read`           | Search and read messages and attachments     |
| `mail.draft.create` | Opt-in  | `Mail.ReadWrite`      | Create an unsent draft with file attachments |
| `calendar.read`     | Default | `Calendars.Read`      | Read calendar events and attachments         |
| `calendar.write`    | Opt-in  | `Calendars.ReadWrite` | Create or edit an event                      |
| `chat.read`         | Opt-in  | `Chat.Read`           | List chats and read bounded message history  |
| `chat.write`        | Opt-in  | `Chat.ReadWrite`      | Send plain text to an existing chat          |

The provider never requests `Mail.Send`, application permissions, `.default`, or a client secret.
It exposes no generic Graph request, raw URL, arbitrary OData, mail send/delete, event delete,
invitation response, chat creation, or message edit/delete surface. Entra can return additive Graph
scopes already consented for the same public client; those never become Harness capabilities.

`chat.write` deliberately uses the tenant's already-approved `Chat.ReadWrite` delegated scope rather
than introducing a new `ChatMessage.Send` approval. The capability and provider still expose only
the fixed send-to-existing-chat action; the additional delegated authority has no generic endpoint
or tool through which it can be exercised.

The fixed endpoints follow the Microsoft Graph contracts for [reading a message](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0),
[creating a draft message](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0),
[reading message attachments](https://learn.microsoft.com/en-us/graph/api/message-list-attachments?view=graph-rest-1.0),
[creating an event](https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0),
[reading an event](https://learn.microsoft.com/en-us/graph/api/event-get?view=graph-rest-1.0),
[reading event attachments](https://learn.microsoft.com/en-us/graph/api/event-list-attachments?view=graph-rest-1.0),
[updating an event](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0),
[listing chats](https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0),
[listing chat messages](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0),
and [sending to an existing chat](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0).

Inputs, result counts, date ranges, response bytes, strings, OAuth scopes, and request duration are
bounded. Pagination links are neither followed nor returned; collection results expose only a
`hasMore` boolean. Draft bodies and chat messages use plain text; draft file contents use base64 as
required by Microsoft Graph.

Mail search and calendar-view requests only identification fields, previews, and attachment
presence. Exact message reads request a narrow field set and prefer a plain-text body. Every tool
result uses an explicit, byte-bounded projection. A projected body's `truncated` field reports
provider truncation, while `previewIsPartial` is true for every non-null Graph preview because the
upstream preview is semantically partial. Unknown Graph fields and server-provided continuation
URLs are not included.

Attachment list tools request metadata only so file bytes cannot make the list unusable. The matching
single-attachment tool temporarily preserves validated, bounded Graph `contentBytes` for a small
file or a fixed projection of an attached Outlook item under a sub-512 KiB serialized result
ceiling. Reference attachments return metadata only. This compatibility path does not expose
arbitrary attachment fields or provide file-system delivery; attachment-file delivery requires a
separate Harness-owned surface.

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
