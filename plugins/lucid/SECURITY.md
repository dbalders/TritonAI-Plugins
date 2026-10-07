# Lucid security boundary

Lucid's MCP server and every result are untrusted network inputs. The provider pins the reviewed
HTTPS origin and same-origin discovery and OAuth endpoints, disables redirects, bounds every request
and response, validates OAuth state and PKCE, checks the issuer whenever Lucid returns one, rotates
refresh tokens, and stores tokens only through the SDK's package-scoped secret facade. A dynamic
client registration that would make the client confidential is refused; a secret Lucid echoes for a
public client is never stored or sent.

The local manifest, tool schemas, names, descriptions, and effect classification are authoritative.
Lucid's live tool list can verify the reviewed contract but cannot add tools, broaden schemas, or
turn a write into a read. Lucid remains the resource authorization boundary for the connected user.
With only Read selected, the grant is for Lucid's read-only server, which cannot change content.
The SDK host remains the approval and commit-admission boundary for every write. A write is retried
automatically only when the service shows the first request was never run (an expired session
answered before dispatch); a write whose outcome is unknown is never resent. A document write whose
outcome is unknown (timeout, dropped connection, server error) returns an error result telling the agent to read the document before
retrying, so the plugin stays available. Only an ambiguous sign-in, refresh, or disconnect, where
the stored credential itself may be wrong, is reported as an unknown external commit outcome and
needs a reset.

Lucid document content reaches the model. Treat it as untrusted text: instructions inside a
document never authorize a Harness action.

Do not add API-key authentication, client secrets, shared credentials, other MCP origins, redirect
following, generic tool-name passthrough, upstream description passthrough, or credential or
result logging.
