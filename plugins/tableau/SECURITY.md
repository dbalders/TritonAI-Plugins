# Tableau security

This trusted backend package exposes thirteen read/preview tools and one opt-in write tool. Requests are confined to
`https://tableau.ucsd.edu`, REST API 3.27, and fixed OAuth endpoints; redirects are rejected.
UUID path segments, exact-name filters, pagination, and view filters are validated independently
of the manifest. Agent input cannot supply an origin, arbitrary path, raw Tableau filter expression,
SQL, access token, or credentials.

Browser authorization uses random state, PKCE S256, and a one-use callback on an ephemeral IPv4
loopback listener. The callback validates method, Host, path, state, length, duplicate parameters,
and expiry. It records the code in memory; only host-admitted lifecycle polling exchanges it.
User and site are verified before persistence. Cancellation and close prevent new operations;
lifecycle changes are serialized so disconnect cannot race a credential write.

Credentials are stored only through the injected package secret facade. Token bodies and upstream
error bodies are never logged or echoed. Empty refresh tokens are accepted, preserving the campus
session policy. A refresh is attempted only when a token exists; an uncertain/failed refresh
requires sign-in rather than repeated rotation. Disconnect removes local credentials and attempts
API sign-out; an unconfirmed sign-out is stated in connection status. API sign-out does not claim
to revoke an entire campus SSO session or all connected clients.

Responses and request times are bounded. No truncated CSV is returned as complete. View exports
carry a first-dashboard-worksheet limitation. Names, descriptions, and CSV cells remain untrusted
content. Permission failures do not trigger privilege escalation. Read permission in Harness
is a tool allowlist, not a claim that the underlying user's OAuth credential is scoped read-only.

Remote/mobile clients cannot finish an IPv4 loopback flow on a different device. This version
requires the system browser on the Harness host; it does not expose a callback to the network.

Changes use fixed REST routes, bounded fields, and an account/site-bound, expiring, single-use preview.
Apply requires writeApproved plus host beginCommit admission; preflight conflicts throw before commit.
Plans are serialized with credential lifecycle changes. The provider snapshots payload bytes and hashes
rather than accepting replacement bytes at apply time. XML metadata is escaped, multipart names are fixed,
and upload IDs are validated and encoded. Files are never extracted or executed on the host. Uploaded
Tableau files can contain connection information; the caller must review them and avoid embedded secrets.

Only Tableau-supported published live-to-Hyper sources can receive row updates. No generic HTTP, SQL,
credential changes, user administration, or permission-granting endpoint is exposed. Publishing and row
replacement can be destructive despite preflight checks. External changes between preflight and the
request remain possible. Asynchronous receipt means queued, not completed. Lost responses produce an
explicit uncertain outcome and consume the preview; the provider never retries writes automatically.
