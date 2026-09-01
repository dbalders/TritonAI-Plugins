# Security

The provider is pinned to the exact UC San Diego HTTPS origin and exact
`/app/api/v0/graphql` endpoint. Redirects are rejected. It sends a package-scoped API key only in
the `Authorization` header and never accepts a caller-provided URL, GraphQL document, header, or
product/dataset selector.

Inputs must be plain objects with exact keys. Identifiers, searches, pagination, response bytes,
JSON depth, object breadth, array length, node count, key length, and string size are bounded.
Prototype-related keys are rejected. HTTP and GraphQL failures are normalized without returning
response bodies, server messages, request headers, or API keys. Reads are never automatically
retried; retryable and rate-limit failures are surfaced to the Harness.

The hostname is fixed rather than caller-controlled, and Web PKI validation remains enabled. This
prevents ordinary SSRF and loopback/IP-literal input. As with other `fetch`-based HTTPS clients,
DNS resolution and socket policy ultimately belong to the Node/host network boundary; deployment
egress should allow only the UCSD Kuali origin where stricter DNS pinning is required.

Use a dedicated, least-privilege UCSD Kuali Build user and follow UC San Diego policy before
returning FERPA, HIPAA, export-controlled, or other restricted record data to an AI model.

Report vulnerabilities through the repository security policy. Do not include API keys, document
contents, or personal data in reports.
