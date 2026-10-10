# Security notes

- Authentication is per-user Jira OAuth 2.0 authorization code with PKCE (S256) and a fresh,
  timing-safe compared `state`. The browser returns through the TritonAI relay to a one-use
  `127.0.0.1` listener that accepts one GET with the exact host, path, and parameters, then closes.
- The Jira client secret exists only in the private relay. Harness configuration contains the public
  client ID and relay origin. Redeeming a code requires the PKCE verifier, which only Harness holds;
  a code relayed to the wrong machine or copied from browser history is useless.
- The refresh token is stored only in the Harness package-scoped secret store. Access tokens remain in
  memory. Neither appears in status, connection results, tool results, errors, or logs.
- Refresh-token rotation is admitted through the host commit boundary before the request is sent,
  serialized, and never retried concurrently. An unsaved rotated token is kept in memory and saved
  later; a definitive rejection requires a new sign-in.
- Configuration rejects alternate Jira origins, non-HTTPS or path-bearing relay origins, and
  malformed client IDs. HTTP redirects are rejected.
- Tools are fixed REST operations with strict input validation. Responses are byte-, shape-, and
  size-bounded projections.
- Writes require the opt-in write ability, a `WRITE` grant, Harness write approval, and commit
  admission, in that order, for one previously prepared change. Previews are single-use, expire
  after ten minutes, and are bound to the Jira account and connection. Applying rechecks the target
  first and never retries after dispatch. Duplicate appends after an unknown outcome are refused
  until acknowledged.
- The approval summary is one bounded line, so long written text is shortened there with its full
  length noted. The preview returns every written value in full and its hash covers the exact
  request, so nothing can be sent that differs from the preview.
- Jira permissions remain authoritative. The plugin requests no admin scopes and cannot change
  permissions or project configuration.

Never place a live UCSD Jira token, client secret, issue content, project data, or reversible
credential material in source, tests, logs, screenshots, issues, or pull requests.
