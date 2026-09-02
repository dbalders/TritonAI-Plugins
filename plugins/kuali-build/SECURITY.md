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

Writes require the single opt-in `kuali-build.write` capability, host `writeApproved`, explicit tool-level
confirmation fields, and exactly one `beginCommit` admission immediately before each mutation.
Document edits use a pre-write `meta.updatedAt` stale check, normalize only bounded Kuali form keys,
and require extra confirmation for null values. The stale check is not atomic because the
documented Kuali mutation does not expose compare-and-set semantics.

No mutation is automatically retried. Ambiguous failures after commit—including cancellation,
timeout, network loss, a 5xx response, invalid or oversized responses, or GraphQL partial data—are
reported as `external_commit_outcome_unknown` without including form data or credentials. Operators
must inspect Kuali before taking another action.

Draft initialization and submission are separate external commits with a read-only resolution step
between them. They are not atomic; initialization can leave an empty draft. Approval, denial,
send-back, reassignment, withdrawal, deletion, builder administration, and arbitrary GraphQL are not
implemented because reviewed mutation contracts were not available.

Legacy credentials that granted both former write capabilities are migrated to unified write when
the connection is updated. A partial legacy write grant is conservatively normalized to read-only;
the user can enable unified write without re-entering the stored API key.

The hostname is fixed rather than caller-controlled, and Web PKI validation remains enabled. This
prevents ordinary SSRF and loopback/IP-literal input. As with other `fetch`-based HTTPS clients,
DNS resolution and socket policy ultimately belong to the Node/host network boundary; deployment
egress should allow only the UCSD Kuali origin where stricter DNS pinning is required.

Use a dedicated, least-privilege UCSD Kuali Build user and follow UC San Diego policy before
returning FERPA, HIPAA, export-controlled, or other restricted record data to an AI model.

Report vulnerabilities through the repository security policy. Do not include API keys, document
contents, or personal data in reports.
