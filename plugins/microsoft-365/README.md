# Microsoft 365 plugin

Trusted server-side TritonAI Harness provider for bounded Microsoft 365 mail, calendar, and chat
access. Mail and calendar reads are enabled by default. Draft creation, calendar writes, chat read,
and chat send are separate opt-in capabilities.

## Capability and authorization surface

| Capability          | Access  | Delegated scope       | Fixed actions                                   |
| ------------------- | ------- | --------------------- | ----------------------------------------------- |
| `mail.read`         | Default | `Mail.Read`           | Search previews and read bounded message bodies |
| `mail.draft.create` | Opt-in  | `Mail.ReadWrite`      | Create an unsent plain-text draft               |
| `calendar.read`     | Default | `Calendars.Read`      | Read a bounded calendar view                    |
| `calendar.write`    | Opt-in  | `Calendars.ReadWrite` | Create or edit an event                         |
| `chat.read`         | Opt-in  | `Chat.Read`           | List chats and read bounded message history     |
| `chat.write`        | Opt-in  | `Chat.ReadWrite`      | Send plain text to an existing chat             |

The provider never requests `Mail.Send`, application permissions, `.default`, or a client secret.
It exposes no generic Graph request, raw URL, arbitrary OData, mail send/delete, event delete,
invitation response, chat creation, or message edit/delete surface. Entra can return additive Graph
scopes already consented for the same public client; those never become Harness capabilities.

`chat.write` deliberately uses the tenant's already-approved `Chat.ReadWrite` delegated scope rather
than introducing a new `ChatMessage.Send` approval. The capability and provider still expose only
the fixed send-to-existing-chat action; the additional delegated authority has no generic endpoint
or tool through which it can be exercised.

The fixed endpoints follow the Microsoft Graph contracts for [creating a draft message](https://learn.microsoft.com/en-us/graph/api/user-post-messages?view=graph-rest-1.0),
[creating an event](https://learn.microsoft.com/en-us/graph/api/calendar-post-events?view=graph-rest-1.0),
[updating an event](https://learn.microsoft.com/en-us/graph/api/event-update?view=graph-rest-1.0),
[listing chats](https://learn.microsoft.com/en-us/graph/api/chat-list?view=graph-rest-1.0),
[listing chat messages](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0),
and [sending to an existing chat](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0).

Inputs, result counts, date ranges, response bytes, strings, OAuth scopes, and request duration are
bounded. Pagination links are never followed or returned. Results are projected into explicit
shapes rather than returning arbitrary Graph payloads. All writes use plain text.

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
for tool disclosure and invocation, and Harness obtains approval before every write unless the user
accepts that exact tool for the current session.
