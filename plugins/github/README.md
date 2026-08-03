# TritonAI GitHub plugin

Connect TritonAI Harness to GitHub with a GitHub App user access token and GitHub's device authorization flow. Users sign in with a short code in their browser; TritonAI never asks them to paste a token.

This package is a Harness v2 provider. It contains fixed REST tools for identity, installed repositories, repository files and search, issues, pull requests, Actions runs and jobs, checks, and commit status. It does not expose arbitrary URLs, HTTP methods, GraphQL, git, a shell, or token passthrough.

## GitHub App registration

Create one public GitHub App for the TritonAI distribution and configure:

- Enable **Device Flow**.
- Keep **User-to-server token expiration** enabled. GitHub device-flow tokens can be refreshed with the public client ID and rotating refresh token; no client secret belongs in this native package.
- Do not configure webhooks for this v1 plugin.
- Set repository permissions to:
  - Metadata: read (GitHub requires this).
  - Contents: read.
  - Issues: read and write.
  - Pull requests: read and write.
  - Actions: read.
  - Checks: read.
  - Commit statuses: read.
- Do not grant Administration, Secrets, Workflows, Members, or other organization/admin permissions.

Install the app only on the repositories that TritonAI should be able to reach. A GitHub App user token is bounded by both the signed-in user's access and each app installation's selected repositories and permissions.

Harness configuration must contain exactly:

```json
{ "clientId": "Iv23linqGnywexMxC0xQ" }
```

`Iv23linqGnywexMxC0xQ` is the public client ID for the production TritonAI Harness GitHub App. Never add a client secret or private key to this package. OAuth credentials are written only to the encrypted, package-scoped Harness secret store under the package-local `github-app-user` suffix.

## Capability model

- `identity.read` and `repository.read` are enabled by default.
- `issues.write` and `pull-requests.write` are explicit opt-ins.
- Every mutation is declared `effect: write`, checks `context.writeApproved`, and obtains `beginCommit()` before the request is sent.

GitHub App installation permissions are the outer server-enforced ceiling. Harness capabilities are an additional per-user policy boundary: installing an app with issue or pull-request write permission does not automatically enable TritonAI write tools.

## Deliberate v1 limits

The plugin cannot delete or merge, create repositories, push commits, create branches, change branch protection, manage collaborators, change repository settings, read or write secrets, mutate workflows, manage releases, or administer GitHub Apps. Pull requests can only be created between branches or refs that already exist.

Repository creation is intentionally absent: GitHub's authenticated-user repository creation surface would require broad repository Administration write permission, which this plugin does not request.

The file tool reads one exact file, rejects directories, and has a one-megabyte file ceiling. Lists accept at most 50 records per page and at most page 10. Requests time out, reject redirects, and cap response bytes. GitHub Enterprise Server is not supported.

## Sign-in and recovery

1. Enable the desired capabilities in Harness and choose Connect.
2. Open the displayed `https://github.com/login/device` address and enter the one-time code.
3. Authorize the GitHub App. Install it on the desired personal or organization repositories if it is not already installed.
4. Harness polls no faster than GitHub's returned interval and verifies the resulting token with `GET /user` plus `GET /user/installations` before storing it.

If an organization uses SAML SSO, establish the required organization session and reauthorize if repository access is missing. A `403` generally means the app installation, selected repository, app permission, or user permission is insufficient. A `404` can intentionally hide an inaccessible private repository.

Disconnect removes TritonAI's local encrypted credential. To revoke the authorization server-side, also remove the app authorization or installation in GitHub settings.

## Development

```sh
pnpm --filter @tritonai/plugin-github typecheck
pnpm --filter @tritonai/plugin-github test
pnpm --filter @tritonai/plugin-github build
pnpm validate
pnpm package:dry-run
```

The package contract check additionally requires `TRITONAI_HARNESS_ROOT` and `TRITONAI_HARNESS_COMMIT` to identify the clean checkout pinned by `scripts/reviewed-harness.mjs`.
