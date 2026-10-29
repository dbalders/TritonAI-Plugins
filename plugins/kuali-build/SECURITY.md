# Security

The provider is pinned to the exact UC San Diego HTTPS origin and exact
`/app/api/v0/graphql` endpoint. Redirects are rejected. It sends a package-scoped API key only in
the `Authorization` header and never accepts a caller-provided URL, header, or product/dataset
selector. The general GraphQL tools accept a caller-provided GraphQL document, which is parsed and
classified locally before it is sent (see below).

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
between them. They are not atomic; initialization can leave an empty draft.

## General GraphQL access

The general tools expose whatever the connected user's Kuali API key can do. Kuali API keys have no
scopes, so the plugin's permissions are the only narrowing layer, and Kuali's own user permissions
remain the final authority.

- Each document is tokenized and parsed by the plugin (no third-party parser). Exactly one query or
  mutation is allowed; subscriptions, multiple operations, type-system definitions, `@defer`, and
  `@stream` are refused. Documents are limited to 32,768 characters, 8,000 tokens, nesting depth 24,
  1,000 selections, and fragment-spread chains 24 deep anywhere in the document. Fragment expansion is computed once per
  fragment, so repeated spreads cannot blow up classification work.
- Queries need `kuali-build.read`. A mutation must select exactly one root field. Classification uses
  the real field name after resolving aliases, fragment spreads, and inline fragments. Only fields on
  the reviewed Write allowlist run under `kuali-build.write`; every other mutation, including fields
  Kuali adds without notice, requires the opt-in `kuali-build.admin` capability. A name backstop keeps
  delete/permission/credential/configuration-style names in Admin even if allowlisted by mistake.
- Classification is by root field name only. A Write-list field could still do something drastic
  through its arguments; host approval of the exact document and variables is the control for that.
- A mutation root field cannot use `@skip` or `@include`.
- Mutations follow the same commit and no-retry rules as the dedicated tools. Only a response with
  GraphQL errors and no `data` member at all is reported as not executed. Errors alongside any
  `data` member (including `data: null`, authorization error codes, and 4xx/5xx statuses that still
  carry `data`), a success response missing
  the mutation's result, 5xx responses, timeouts, network loss, and cancellation after commit are
  `external_commit_outcome_unknown`.
- Unlike the dedicated tools, general tools return Kuali GraphQL error messages so the assistant can
  correct its request. Messages are limited to five, 500 characters each, with control characters
  removed. They are server text and may echo request values.
- In general-tool responses, values under credential-like keys (`apiKey`, `secret`, `token`,
  `password`, and similar), including aliased selections of those fields (matched by response path) and whole nested objects,
  are replaced with `[redacted by TritonAI]`. This is a backstop, not a guarantee that sensitive
  record data is removed; the dedicated tools return document data as before.

Legacy credentials that granted both former write capabilities are migrated to unified write when
the connection is updated; migration never grants `kuali-build.admin`. A partial legacy write grant is conservatively normalized to read-only;
the user can enable unified write without re-entering the stored API key.

The hostname is fixed rather than caller-controlled, and Web PKI validation remains enabled. This
prevents ordinary SSRF and loopback/IP-literal input. As with other `fetch`-based HTTPS clients,
DNS resolution and socket policy ultimately belong to the Node/host network boundary; deployment
egress should allow only the UCSD Kuali origin where stricter DNS pinning is required.

Use a dedicated, least-privilege UCSD Kuali Build user and follow UC San Diego policy before
returning FERPA, HIPAA, export-controlled, or other restricted record data to an AI model.

Report vulnerabilities through the repository security policy. Do not include API keys, document
contents, or personal data in reports.
