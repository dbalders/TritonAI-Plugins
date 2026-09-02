# UC San Diego Kuali Build

This dependency-free TritonAI plugin provides bounded reads and tightly allowlisted document writes
for the UC San Diego Kuali Build tenant at `https://ucsd.kualibuild.com`. It calls the documented
Kuali Build GraphQL endpoint directly over HTTPS and does not install or launch Kuali Connector.

## Connection

Open the UCSD Kuali Build [API Keys page](https://ucsd.kualibuild.com/build/space/favorites/account/api-keys),
sign in if prompted, create a new API key, and copy the full key when Kuali displays it. Then enable
the plugin, select **Open API key settings** if you still need the page, paste the key, and select
**Connect**. The key is validated against the UCSD tenant before it is stored through the Harness
package-scoped secret store. Kuali ties each key to a user and applies that user's existing
permissions.

The only accepted tenant configuration is `https://ucsd.kualibuild.com`; an omitted `tenantUrl`
defaults to that exact origin. Paths, query strings, credentials, non-HTTPS URLs, lookalike hosts,
and alternate ports are rejected.

## Scope

The plugin exposes fixed reads for Build apps, form schemas, Build documents, users, workflow
metadata, and initialized draft actions. Its opt-in write capabilities provide only the mutation
shapes established by the official Build GraphQL guides:

- update explicitly supplied fields on an existing document;
- initialize an empty draft for one exact app;
- resolve the initialized draft ID from its action ID; and
- submit that matching draft with fixed status `completed`, starting its configured workflow.

Document lists return IDs and pagination only; fetching form data or workflow metadata requires an
exact document ID. It deliberately excludes Kuali Curriculum, Sponsored Programs, product datasets,
arbitrary GraphQL, attachments, exports, administrative APIs, app/form builder operations,
deletion, approval, denial, send-back, reassignment, withdrawal, cancellation, and secondary
workflow administration.

## Write safety and creation phases

Every mutation requires an enabled opt-in capability, host write approval, and exactly one
`beginCommit` call immediately before the request. Network, timeout, oversized/malformed response,
post-commit cancellation, partial-data, and server-side ambiguity are returned as
`external_commit_outcome_unknown`; writes are never automatically retried.

Document updates require a recent `meta.updatedAt` value and explicit `confirmUpdate: true`. This is
a best-effort stale check, not an atomic server-side compare-and-set. Null values additionally
require `confirmNullValues: true` because they may clear data.

Kuali's documented creation flow is intentionally exposed as three separate tools: initialize an
empty draft, resolve its document ID, then submit it. These phases are not atomic. A successful
initialization can leave an empty draft when a later phase fails, and an unknown initialization or
submission outcome must be inspected in Kuali before any further action.

References:

- https://developers.kualibuild.com/
- https://developers.kualibuild.com/authentication
- https://developers.kualibuild.com/update-document
- https://developers.kualibuild.com/start-workflow
- https://connector.kuali.co/

From the repository root, run `pnpm --filter @tritonai/plugin-kuali-build test` and
`pnpm artifacts:sdk` to test and seal the deterministic artifact.
