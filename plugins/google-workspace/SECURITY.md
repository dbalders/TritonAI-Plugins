# Google Workspace security boundary

This is a delegated-user integration. It has no service-account, domain-wide delegation, API-key,
embedded-webview, remote-callback, generic REST, or Workspace administration path.

## Credential handling

- OAuth state, PKCE verifier, nonce, codes, tokens, and raw page tokens never enter tool results,
  skills, logs, browser state, or package files.
- The Google-issued installed-app credential is build-injected and sent only to Google's token
  endpoint. It is extractable from the desktop binary and is not an authorization boundary.
- The synchronous entrypoint factory accepts only the package-scoped secret store and an exact
  plain-object configuration containing `clientId` and `clientSecret` strings. Invalid
  configuration is rejected without disclosing its values.
- Pending authorization is memory-only. Refresh tokens and verified identity use the
  package-scoped Harness encrypted secret store.
- Token exchange, refresh rotation, revocation, and deletion cross Harness commit admission.
  Ambiguous admitted mutations fault the provider until disconnect/reset.
- Disconnect revokes the refresh token before deleting local storage.

## Browser OAuth

The provider binds an ephemeral `127.0.0.1` listener. Callbacks enforce the exact host/path, local
peer, GET, single-use state, expiry, generation, PKCE S256, and nonce. ID tokens require a valid
Google RS256 signature, audience, issuer, timestamps, verified email, and `hd: ucsd.edu`.

New flows supersede old listeners. Callback pages are static and contain no code or token. Restart
fails closed; shutdown aborts requests and closes listeners.

## Remote data

Endpoints and methods are fixed. Inputs cannot supply hosts, URLs, methods, raw query/body
passthrough, or field masks. Responses have byte ceilings and abort-aware timeouts; binary content
is bounded base64. Continuation cursors are authenticated and account-bound.

Writes require the selected scope, `writeApproved === true`, and commit admission immediately before
the fixed mutation. Gmail creates unsent plain-text drafts only. Calendar sends no updates and
cannot manage attendees, responses, ownership, ACLs, sharing, or deletion. The provider retains
`connect` and `disconnect` recovery behavior for faulted write state.

Report suspected vulnerabilities privately to the TritonAI Harness maintainers. Do not include
tokens, authorization codes, credentials JSON, user messages, attachments, or calendar content in
an issue or diagnostic transcript.
