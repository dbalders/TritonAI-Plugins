# UC San Diego Kuali Build

This dependency-free TritonAI plugin provides bounded, read-only access to the UC San Diego Kuali
Build tenant at `https://ucsd.kualibuild.com`. It calls the documented Kuali Build GraphQL endpoint
directly over HTTPS and does not install or launch Kuali Connector.

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

The plugin exposes fixed operations for Build apps, form schemas, Build documents, users, and a
document's workflow metadata. It deliberately excludes Kuali Curriculum, Sponsored Programs,
product datasets, arbitrary GraphQL, attachments, exports, administrative APIs, and mutations.

Kuali's documented workflow start requires multiple externally visible requests. This first
version remains read-only because that sequence cannot be treated as one atomic commit under the
SDK v1 write boundary without risking an orphaned draft or duplicate replay after an unknown
network outcome.

References:

- https://developers.kualibuild.com/
- https://developers.kualibuild.com/authentication
- https://connector.kuali.co/

From the repository root, run `pnpm --filter @tritonai/plugin-kuali-build test` and
`pnpm artifacts:sdk` to test and seal the deterministic artifact.
