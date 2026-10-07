# n8n security boundary

The configured remote MCP server and every result are untrusted network inputs. The provider pins
the reviewed HTTPS endpoint and same-origin discovery endpoints, disables redirects, bounds all
requests and responses, validates OAuth state and PKCE, rotates refresh tokens, and stores tokens
only through the SDK's package-scoped secret facade.

The local manifest, tool schemas, and effect classification are authoritative. Upstream tool
discovery can verify the reviewed contract but cannot add tools, broaden schemas, or downgrade a
write into a read. n8n remains the resource authorization boundary for the connected user's own
account. The SDK host remains the approval and commit-admission boundary for writes. Nothing is
ever replayed automatically after admission. A tool write whose outcome is unknown (timeout,
dropped connection, server error) returns an error result telling the agent to check the current
state before retrying, so the plugin stays available. Only an ambiguous sign-in, refresh, client
registration, or disconnect, where the stored credential itself may be wrong, is reported as an
unknown external commit outcome and needs a reset.

Do not add API-key authentication, client secrets, shared credentials, arbitrary MCP origins,
redirect following, generic tool-name passthrough, or credential/result logging.
