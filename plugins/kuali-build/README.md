# UC San Diego Kuali Build

This dependency-free TritonAI plugin gives the assistant the same Kuali Build GraphQL API access
the connected user's API key has, for the UC San Diego tenant at `https://ucsd.kualibuild.com`.
Dedicated tools cover common document work; general GraphQL tools cover everything else, sorted
into Read, Write, and Admin & delete permissions. It calls the Kuali Build GraphQL endpoint directly
over HTTPS and does not install or launch Kuali Connector.

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

## Permissions

| Permission                               | Default | What it allows                                                                                              |
| ---------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| Read UCSD Kuali Build                    | On      | The dedicated read tools, browsing the GraphQL schema, and any GraphQL **query**                            |
| Create, edit, and submit Build documents | Off     | The dedicated document tools and GraphQL **mutations** on the reviewed Write list                           |
| Admin & delete in Kuali Build            | Off     | Any other GraphQL mutation, including deletes and changes to apps, forms, workflows, users, and permissions |

Kuali still applies the connected user's own permissions to every request. Turning on Admin & delete
does not give anyone access they don't already have in Kuali.

## Tools

The original dedicated tools are unchanged: app list/get, published form schema, document list/get,
user lookup, workflow status, draft resolution, and the three document writes (update, initialize
draft, submit).

General GraphQL tools:

- `kuali-build.graphql.schema` (Read) browses the live schema. Without arguments it lists root
  queries, root mutations with the permission each needs, and type names. With `typeName` it returns
  that type's fields, arguments, input fields, and enum values. The root type list is cached for one
  hour per connection.
- `kuali-build.graphql.query` (Read) runs one query and returns `data` plus sanitized Kuali error
  messages.
- `kuali-build.graphql.mutate` (Write) runs one mutation whose single root field is on the reviewed
  Write list. Today that list is `updateDocument`, `initializeWorkflow`, and `submitDocument`.
- `kuali-build.graphql.admin` (Admin & delete) runs any one mutation.

Every general request is parsed before it is sent. The plugin accepts exactly one query or mutation
(fragments allowed) and refuses subscriptions, multiple operations, schema definitions, `@defer`, and
`@stream`. A mutation must select exactly one root field so its outcome can be checked. Aliases,
fragment spreads, and inline fragments are resolved to the real field name before classification, so
renaming a field cannot move it into a lower permission. Any mutation not on the Write list,
including fields Kuali adds later, needs Admin & delete. Names suggesting deletion, access control,
credentials, or configuration are always Admin even if added to the Write list by mistake.

Responses redact string values under keys such as `apiKey`, `secret`, `token`, and `password`.
HR feed import (REST), PDF export (callback URL), and attachment transfer (temporary URLs) are not
GraphQL operations and are not covered.

## Write safety and creation phases

Every mutation requires its permission (`kuali-build.write` for dedicated tools and Write-list
mutations, `kuali-build.admin` for everything else), host write approval, explicit confirmation in
the tool input, and exactly one `beginCommit` call immediately before the request. Network, timeout, oversized/malformed response,
post-commit cancellation, partial-data, and server-side ambiguity are returned as
`external_commit_outcome_unknown`; writes are never automatically retried.

Document updates require a recent `meta.updatedAt` value and explicit `confirmUpdate: true`. This is
a best-effort stale check, not an atomic server-side compare-and-set. Null values additionally
require `confirmNullValues: true` because they may clear data.

Kuali's documented creation flow is intentionally exposed as three separate tools: initialize an
empty draft, resolve its document ID, then submit it. These phases are not atomic. A successful
initialization can leave an empty draft when a later phase fails, and an unknown initialization or
submission outcome must be inspected in Kuali before any further action.

Existing connections do not need to reveal or re-enter their API key when changing permissions.
Connections that previously granted both legacy write permissions are recognized as unified write.
A connection with only one legacy write permission is treated as read-only until the user enables
the new unified write permission, preventing a silent expansion of access. Admin & delete is never
granted by migration; it must be switched on explicitly.

References:

- https://developers.kualibuild.com/
- https://developers.kualibuild.com/authentication
- https://developers.kualibuild.com/update-document
- https://developers.kualibuild.com/start-workflow
- https://connector.kuali.co/

From the repository root, run `pnpm --filter @tritonai/plugin-kuali-build test` and
`pnpm artifacts:sdk` to test and seal the deterministic artifact.
