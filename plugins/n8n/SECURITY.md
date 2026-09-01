# n8n security boundary

The configured remote MCP server and every result are untrusted network inputs. The provider pins
the reviewed HTTPS endpoint and same-origin discovery endpoints, disables redirects, bounds all
requests and responses, validates OAuth state and PKCE, rotates refresh tokens, and stores tokens
only through the SDK's package-scoped secret facade.

The local manifest, tool schemas, and effect classification are authoritative. Upstream tool
discovery can verify the reviewed contract but cannot add tools, broaden schemas, or downgrade a
write into a read. n8n remains the resource authorization boundary for the connected user's own
account. The SDK host remains the approval and commit-admission boundary for writes. Once admitted,
ambiguous network or secret-store failures are reported as an unknown external commit outcome and
must not be replayed automatically.

Do not add API-key authentication, client secrets, shared credentials, arbitrary MCP origins,
redirect following, generic tool-name passthrough, or credential/result logging.
