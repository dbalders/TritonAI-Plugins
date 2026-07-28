# Google Workspace

`@tritonai/plugin-google-workspace` is the UC San Diego Google Workspace provider for TritonAI
Harness. It uses a native desktop OAuth client, the user's system browser, an ephemeral loopback
listener, authorization code flow, PKCE, state, and an OpenID Connect nonce. Tokens remain in the
Harness package-scoped encrypted secret store.

The Google Cloud OAuth application must have an **Internal** audience in the UC San Diego
organization. The provider also requires the verified ID token `hd` claim to equal `ucsd.edu`; that
check is defense in depth and does not replace the Google Cloud Internal audience or Workspace
administrator policy.

## Access model

- `identity.read`, `drive.read`, `mail.read`, and `calendar.read` are selected by default.
- `mail.draft.create` and `calendar.write` require explicit opt-in.
- Draft creation produces an unsent plain-text draft only. There is no send tool.
- Calendar writes omit attendees, invitation responses, conference creation, ACLs, sharing,
  ownership changes, and delete operations.
- Calendar writes return only a bounded ID receipt; event details remain behind `calendar.read`.
- Drive, Docs, Sheets, and Slides are read-only.

The provider requests only scopes corresponding to selected Harness capabilities. Google can keep
previously granted scopes on a refresh token, so the provider separately checks the selected
Harness capability, its canonical scope, the fixed tool allowlist, and task write approval for
every invocation.

## Google OAuth configuration

Provide the native-client ID and Google-issued desktop client credential through the
Harness-managed build configuration:

```text
TRITONAI_GOOGLE_WORKSPACE_CLIENT_ID=123456789-example.apps.googleusercontent.com
TRITONAI_GOOGLE_WORKSPACE_CLIENT_SECRET=<Google-issued desktop client credential>
```

Do not download or commit an OAuth credential JSON file, and never put either value in runtime
settings or logs. Google issues a client credential for installed applications and requires it at
the token endpoint for this client. It is embedded at build time alongside the client ID, is
extractable from a distributed desktop binary, and is therefore not a confidential security
boundary. PKCE, state, nonce, loopback-only callbacks, Google Cloud's Internal audience, and the
verified hosted-domain claim remain the authorization controls. User refresh tokens remain only in
the Harness package-scoped encrypted secret store.

The configured OAuth project must enable Google Drive, Gmail, Calendar, Docs, Sheets, and Slides
APIs. Its consent configuration must include:

- `openid`, `email`, and `profile`
- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/documents.readonly`
- `https://www.googleapis.com/auth/spreadsheets.readonly`
- `https://www.googleapis.com/auth/presentations.readonly`
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/gmail.compose`
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
- `https://www.googleapis.com/auth/calendar.events.readonly`
- `https://www.googleapis.com/auth/calendar.events`

`drive.readonly`, `gmail.readonly`, and `gmail.compose` are restricted scopes. An Internal app does
not make them automatically available to every UC San Diego user; Google Workspace administrators
can still require the OAuth client to be trusted or allowlisted.

Google's `gmail.compose` scope also authorizes sending at the token layer. This package deliberately
exposes no send endpoint and never accepts an arbitrary Gmail method, URL, query body, or REST
payload. The residual scope authority remains an administrator-review consideration.

## Tool limits

All remote hosts, paths, and methods are fixed in provider code. Inputs use exact Effect schemas.
Lists are bounded to 50 items, date ranges to 31 days, JSON responses to one or four MiB depending
on the resource, and attachment/content reads to five MiB. Pagination cursors are short-lived,
HMAC-authenticated, and bound to the issuing tool, path, and Google subject. Raw Google page tokens
and continuation URLs are never returned.

Run package checks from the repository root:

```text
pnpm --filter @tritonai/plugin-google-workspace typecheck
pnpm --filter @tritonai/plugin-google-workspace test
pnpm --filter @tritonai/plugin-google-workspace build
pnpm package:dry-run
```
