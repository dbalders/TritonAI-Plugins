# GitHub plugin security

## Boundary

The plugin accepts only a public GitHub App client ID. Device and refresh codes, access and refresh tokens, and authorization headers are never tool inputs or outputs. Stored credentials use the Harness-injected, encrypted, package-scoped secret store.

GitHub App permissions and selected repositories provide the server-side ceiling. The signed-in user's own permissions further restrict the user access token. Harness capabilities and commit admission form a separate local policy boundary.

## Network surface

The provider contacts only:

- `https://github.com/login/device/code`
- `https://github.com/login/oauth/access_token`
- fixed paths under `https://api.github.com`

It rejects redirects, bounds time and response bytes, validates identifiers and refs, and never accepts a URL, method, GraphQL document, shell command, or authorization token from a tool call.

## Mutations

Only bounded issue create/update/comment and pull-request create/comment/review operations are present. Write capabilities are enabled by default but can still be disabled individually. Every mutation requires its capability plus `writeApproved: true`, then calls `beginCommit()` immediately before the network mutation. There are no delete, merge, git-object, branch, workflow, release, secrets, collaborator, installation, or administration mutations.

## Credential lifecycle

The provider verifies new and refreshed tokens with `GET /user` and `GET /user/installations`, validates the GitHub App token's empty OAuth scope and bearer type, supports rotating expiring user tokens, rejects expired refresh credentials, serializes secret mutations, and invalidates in-memory access on disconnect or `401`. If a token may have rotated but encrypted persistence did not complete, the provider enters an uncertain state and requires disconnect/reset.

Disconnect removes the local encrypted record but cannot revoke the GitHub authorization without a confidential app credential. Users can revoke the app in GitHub settings.

## Reporting

Report suspected vulnerabilities privately to the TritonAI maintainers. Do not include access tokens, refresh tokens, device codes, private repository contents, or full authorization headers in reports or logs.
