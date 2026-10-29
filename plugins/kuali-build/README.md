# UC San Diego Kuali Build

This dependency-free TritonAI plugin gives the assistant the same Kuali Build GraphQL API access
the connected user's API key has, for the UC San Diego tenant at `https://ucsd.kualibuild.com`.
Dedicated tools cover building apps, forms, and workflows and working with documents, the way the
Kuali Build web app does; general GraphQL tools cover everything else. Access is split into Read,
Write (create and edit), and Admin (delete) permissions. It calls the Kuali Build GraphQL endpoint directly
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

| Permission                     | Default | What it allows                                                                                                                      |
| ------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Read UCSD Kuali Build          | On      | Read anything the user can see: apps, app setup (forms and workflows), documents, users, workflow status, and any GraphQL **query** |
| Create and edit in Kuali Build | Off     | Create and edit anything: apps, forms, workflows, documents; publish; approve, deny, send back, withdraw, duplicate                 |
| Admin: delete in Kuali Build   | Off     | Delete apps, documents, and workflows, and any other request that deletes or discards data                                          |

Kuali still applies the connected user's own permissions to every request. These switches never give
anyone access they don't already have in Kuali.

The Write permission's id changed from `kuali-build.write` to `kuali-build.edit` when it grew from
document work to building anything, so an earlier grant never silently gains the broader access.
Saved API keys keep working; users who had the earlier write permission turn on the new Write switch
once. Admin is never granted automatically.

## Tools

**Reading:** app list/get, published form fields, document list/get, user lookup, workflow status,
draft resolution, `kuali-build.apps.configuration.get` (an app's full builder setup: pages, form
template, workflow, secondary workflows), and the general `kuali-build.graphql.schema` and
`kuali-build.graphql.query`.

**Building and editing (Write):** these send the same requests the Kuali Build web app sends.

- Apps: `apps.create`, `apps.update` (name, color, icon), `apps.publish`
- Forms: `forms.update` saves a full form template to the draft
- Workflows: `workflows.update` saves the workflow steps; `workflows.secondary.create`
- Documents: the original `documents.update`, `documents.drafts.initialize`, and `documents.submit`,
  plus `documents.act` (submit/approve with status `completed`, deny with `rejected`),
  `documents.sendback`, `documents.withdraw`, `documents.duplicate`
- Anything else: `graphql.mutate` runs any mutation that doesn't delete

**Deleting (Admin):** `apps.delete`, `documents.delete`, `workflows.secondary.delete`, and
`graphql.delete` for any other delete-type mutation.

All tool names start with `kuali-build.`. Edits to forms and workflows work like the builder: read the
current setup, change it, save the whole structure back, then publish. The form template and workflow
step formats are Kuali's own and are not documented publicly; start from what
`apps.configuration.get` returns.

Every general request is parsed before it is sent. The plugin accepts exactly one query or mutation
(fragments allowed) and refuses subscriptions, multiple operations, schema definitions, `@defer`, and
`@stream`. A mutation must select exactly one root field so its outcome can be checked. Aliases,
fragment spreads, and inline fragments are resolved to the real field name before classification.
Mutations whose names contain delete, remove, archive, purge, destroy, discard, trash, or revoke need
Admin; every other mutation needs Write.

General-tool responses redact values under credential-like keys such as `apiKey`, `secret`, `token`,
and `password`, including aliased selections of those fields.
HR feed import (REST), PDF export (callback URL), and attachment transfer (temporary URLs) are not
GraphQL operations and are not covered.

## Write safety and creation phases

Every change requires its permission (`kuali-build.edit` to create or edit, `kuali-build.admin` to
delete), host write approval, explicit confirmation in the tool input, and exactly one
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

Existing connections do not need to reveal or re-enter their API key when changing permissions.
Any earlier write permission (`kuali-build.write` or the older document/workflow pair) is treated
as read-only until the user turns on the new Write switch, preventing a silent expansion of access.
Admin is never granted by migration.

References:

- https://developers.kualibuild.com/
- https://developers.kualibuild.com/authentication
- https://developers.kualibuild.com/update-document
- https://developers.kualibuild.com/start-workflow
- https://connector.kuali.co/

From the repository root, run `pnpm --filter @tritonai/plugin-kuali-build test` and
`pnpm artifacts:sdk` to test and seal the deterministic artifact.
