# TritonAI GitHub plugin

Connect TritonAI Harness to a user's GitHub account with a traditional GitHub OAuth App and GitHub's device authorization flow. Users authorize once with a short code in their browser. They do not install a GitHub App, select repositories, provide a PEM, or paste a token.

The resulting access follows the signed-in user's GitHub permissions. The plugin requests `repo`, `read:org`, and `workflow`, then offers a fixed set of bounded tools for identity, repositories, files and code search, issues, pull requests, Actions runs and jobs, checks, commit status, forks, branches, and single-file commits. It does not expose arbitrary URLs, HTTP methods, GraphQL, git, a shell, or token passthrough.

## OAuth App registration

Create one GitHub **OAuth App** for the TritonAI distribution:

1. In GitHub developer settings, choose **OAuth Apps** and create a new OAuth App.
2. Use the TritonAI website for the homepage URL. GitHub requires an authorization callback URL during registration; set it to a TritonAI-owned HTTPS URL. This device flow does not redirect to or call that URL.
3. Enable **Device Flow** in the OAuth App settings.
4. Copy the public client ID into Harness distribution configuration.
5. Do not place the OAuth client secret in this native package or Harness configuration.

Harness configuration must contain exactly:

```json
{ "clientId": "<public-oauth-app-client-id>" }
```

OAuth credentials are written only to the encrypted, package-scoped Harness secret store under the `github-oauth-user` suffix. Traditional OAuth App device grants are ordinary non-expiring tokens and do not use refresh tokens. A successful OAuth connection or disconnect also removes the obsolete credential slot used by earlier GitHub App builds.

## Requested OAuth scopes

- `repo`: repository code, issues, pull requests, statuses, and related metadata across public and private repositories the user can access.
- `read:org`: organization membership and team context available to the user.
- `workflow`: update GitHub Actions workflow files when the user explicitly approves a bounded content commit.

OAuth scopes do not grant access the user does not already have. Organization OAuth restrictions, SAML SSO authorization, branch protection, rulesets, and repository permissions still apply. Harness capabilities provide an additional local boundary over the narrower tool surface.

## Capability model

All five capabilities are enabled by default:

- `identity.read`
- `repository.read`
- `repository.write`
- `issues.write`
- `pull-requests.write`

Every mutation is declared `effect: write`, requires its capability and `context.writeApproved: true`, and obtains `beginCommit()` immediately before the mutation request. Default-on capabilities do not bypass the active task's write-approval policy.

`repository.write` adds the smallest ordinary contribution flow:

1. `github.repositories.fork` creates a fork in the signed-in user's personal account.
2. `github.branches.create` creates a branch from an existing commit, branch, or tag in the same repository.
3. `github.contents.put` creates or updates one UTF-8 file, up to one megabyte, and commits it to an existing branch. Updates require the exact blob SHA returned by `github.contents.get`.
4. `github.pulls.create` opens the pull request after the branch contains the desired commit.

Users with repository write access can branch and commit directly. Users without it can use the fork, branch, commit, and pull-request flow. Fork creation is asynchronous on GitHub, so a newly created fork may need a short wait before branch creation succeeds.

## Deliberate limits

The plugin cannot delete or merge, create repositories, delete branches, change branch protection or rulesets, manage collaborators, change repository settings, read or write secrets, administer organizations, manage billing, manage releases, or administer OAuth/GitHub Apps. It cannot create arbitrary multi-file git trees or upload binary files; each content mutation is one bounded UTF-8 file and one commit.

The read file tool requires an exact file path, rejects directories, and has a one-megabyte ceiling. Lists accept at most 50 records per page and at most page 10. Requests time out, reject redirects, and cap response bytes. GitHub Enterprise Server is not supported.

## Sign-in and recovery

1. Enable the plugin, review its default capabilities, and choose Connect.
2. Open the displayed `https://github.com/login/device` address and enter the one-time code.
3. Authorize the TritonAI OAuth App. There is no GitHub App installation or repository picker.
4. Harness polls no faster than GitHub's returned interval, requires the exact `repo`, `read:org`, and `workflow` grant, verifies the account with `GET /user`, and stores the token only after commit admission.

`github.repositories.list` uses bounded authenticated-user repository enumeration (`GET /user/repos`) and therefore reflects repositories available to the user and OAuth token. If an organization uses SAML SSO or OAuth App restrictions, authorize the application as required by that organization. A `403` generally means user permission, organization policy, SSO, branch policy, or OAuth authorization is insufficient. A `404` can intentionally hide an inaccessible private repository.

Disconnect removes TritonAI's local encrypted credential. To revoke server-side access, remove TritonAI from GitHub **Settings > Applications > Authorized OAuth Apps**.

## Development

```sh
pnpm --filter @tritonai/plugin-github typecheck
pnpm --filter @tritonai/plugin-github test
pnpm --filter @tritonai/plugin-github build
pnpm validate
pnpm package:dry-run
```

The package contract check additionally requires `TRITONAI_HARNESS_ROOT` and `TRITONAI_HARNESS_COMMIT` to identify the clean checkout pinned by `scripts/reviewed-harness.mjs`.
