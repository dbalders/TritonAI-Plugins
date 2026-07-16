# Microsoft 365 Read plugin

Trusted server-side TritonAI Harness provider for bounded read-only Microsoft 365 mail and calendar
access.

## Fixed authorization and network surface

- Deployment-injected public-client Entra client ID and tenant ID; no defaults and no client secret.
- Delegated scopes: `offline_access` plus `Mail.ReadBasic` and/or `Calendars.ReadBasic` selected from the
  fixed manifest capabilities. No `.default`, write scope, application permission, or generic
  proxy.
- Identity requests: the tenant-specific `devicecode` and `token` endpoints under
  `https://login.microsoftonline.com`.
- User verification links: HTTPS only on fixed Microsoft identity hosts.
- Graph requests: `GET https://graph.microsoft.com/v1.0/me/messages` and
  `GET https://graph.microsoft.com/v1.0/me/calendarView` with fixed projected fields.

Inputs, result counts, date ranges, response bytes, strings, OAuth scopes, and request duration are
bounded. Pagination links are never followed or returned. Results are projected into explicit safe
shapes rather than returning arbitrary Graph payloads.

## Secret and lifecycle behavior

The provider receives the Harness package-scoped Effect secret store and uses only suffix `oauth`.
It persists a versioned refresh credential and granted read scopes, never an access token. Device
poll redemption, refresh rotation, and disconnect removal require Harness `beginCommit()` admission
and use its commit-tail signal. Any admitted uncertainty yields error status and zero capabilities
until verified disconnect.

The provider never mutates credentials inside `invoke`. Immediately before invocation, the stacked
Harness integration calls its generic `prepare()` lifecycle hook. The hook returns immediately when
the in-memory access token remains usable or no stored connection exists; otherwise refresh-token
exchange, rotation, and storage run through Harness commit admission.
