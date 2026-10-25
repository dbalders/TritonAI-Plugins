# UC San Diego Kuali Build

SDK2 provides the existing 11 bounded Kuali tools through host-owned broker operations. It requires
a Harness host that implements SDK2, independently approves this package's recipe digest, and
supports verified worker isolation. Older hosts reject version 2.0.0. There is no legacy fallback.

## Connection

Use the host's connection flow to create or select a user-scoped Kuali API key and enable read or
opt-in write access. The host validates and stores the credential for the selected connection;
plugin code receives no API key. Existing package-scoped credentials require an explicit host
migration that preserves their permissions, or reconnecting. This package does not migrate them.

The only tenant is `https://ucsd.kualibuild.com`. The host sends only reviewed GraphQL operations
to `/app/api/v0/graphql`; the worker validates input and projects bounded results.

## Tools and writes

Read apps, published form schemas, document IDs/data, users, workflow metadata and draft-action
identity with the same tool names and input schemas as version 1.1.0. Before editing, read the form
schema to identify form keys and the document to obtain `meta.updatedAt`.

Updates require `confirmUpdate: true` and the exact `expectedUpdatedAt`. The host checks that
version before admitting the exact approved payload. This is a best-effort stale check, not an
atomic compare-and-set. Nulls additionally require `confirmNullValues: true`.

Creating a document is three steps: initialize an empty draft with `confirmCreateDraft: true`,
resolve its document ID from the action ID, then submit the matching draft with `confirmSubmit:
true`. Submission starts its configured workflow. The host checks the action/document binding.
These phases are not atomic; initialization can leave an empty draft. Inspect Kuali after any
unknown outcome before deciding on another action. Writes are never automatically retried.

Arbitrary GraphQL, other tenants, attachments/exports, builder administration, deletion, approval,
denial and secondary workflow administration remain unavailable.

References: https://developers.kualibuild.com/ and https://developers.kualibuild.com/authentication.
Run `pnpm --filter @tritonai/plugin-kuali-build test` and `pnpm artifacts:sdk` from this repository.
Tests use synthetic host/transport fixtures; they do not prove a live Kuali or isolated Harness run.
