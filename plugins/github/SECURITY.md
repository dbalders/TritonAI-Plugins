# GitHub plugin security

## Boundary

The plugin accepts only a public GitHub OAuth App client ID. Device codes, access tokens, and authorization headers are never tool inputs or outputs. There is no client secret, private key, GitHub App installation, repository picker, refresh token, generic HTTP client, GraphQL document, shell, or token passthrough.

The OAuth token requests `repo`, `read:org`, and `workflow`. Those scopes are intentionally broad enough for ordinary developer work across repositories the user can access, but never elevate the user's GitHub permissions. GitHub organization policy, SAML SSO, repository permissions, branch protections, and rulesets remain server-side ceilings. Harness capabilities, write approval, and commit admission form separate local boundaries.

## Network surface

The provider contacts only:

- `https://github.com/login/device/code`
- `https://github.com/login/oauth/access_token`
- fixed paths under `https://api.github.com`

It rejects redirects, bounds time and response bytes, validates identifiers, paths, refs, SHAs, text lengths, and UTF-8 file bytes, and never accepts an origin, URL, REST method, or authorization token from a tool call. Repository enumeration uses only bounded `GET /user/repos`; installation APIs are never called.

## Mutations

The fixed mutation set is:

- issue create/update/comment;
- pull-request create/comment/review;
- fork into the signed-in user's personal account;
- branch creation from an existing same-repository ref; and
- create/update one bounded UTF-8 repository file and commit it to an existing branch.

All write capabilities are enabled by default but can be disabled individually. Every mutation requires its declared capability plus `writeApproved: true`, then calls `beginCommit()` immediately before the network mutation. Read-only lookups used to validate or resolve a target do not substitute for commit admission.

There are no delete, merge, repository creation, branch deletion, settings, protection, collaborator, organization administration, billing, release, secret, deployment-key, OAuth App, or GitHub App mutations. `github.contents.put` can update a workflow file because the product requests `workflow`, but only through the same bounded single-file, approval-gated commit path.

## Credential lifecycle

The provider accepts only a non-expiring bearer token response containing exactly the requested `repo`, `read:org`, and `workflow` scopes. It rejects refresh-token and expiring-token fields, verifies the identity with `GET /user`, serializes secret mutations, and invalidates in-memory access on disconnect or `401`. It never calls installation APIs. If GitHub issued a token but encrypted persistence may not have completed, the provider enters an uncertain state and requires disconnect/reset.

Disconnect removes the local encrypted record but cannot revoke the OAuth token without a confidential app credential. Users can revoke the authorization under GitHub's Authorized OAuth Apps settings.

## Reporting

Report suspected vulnerabilities privately to the TritonAI maintainers. Do not include access tokens, device codes, private repository contents, or full authorization headers in reports or logs.
