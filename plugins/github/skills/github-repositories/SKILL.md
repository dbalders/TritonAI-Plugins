---
name: github-repositories
description: Find, read, fork, branch, and commit bounded GitHub repository content through TritonAI provider tools. Use for repository inspection and ordinary contribution setup.
---

# GitHub repositories and contributions

Use only `github.*` provider tools. Do not assume a separately authenticated `gh` CLI, GitHub connector, shell, or browser session.

1. Use `github.identity.get` when account context matters. Use `github.repositories.count` for an exact accessible-repository count. Use `github.repositories.list` only to enumerate compact pages with `limit` from 1 through 50 and `page` from 1 through 10; there is no GitHub App installation or repository picker.
2. Prefer `github.repositories.get` for exact owner/repository metadata and `github.contents.get` for an exact file. The content tool does not list directories and will not return files over one megabyte.
3. Use `github.code.search` only after narrowing to an exact owner and repository. Use `github.repositories.search` only for discovery; confirm the exact repository before subsequent reads.
4. For contributions, first determine whether the user can write directly. If not, use `github.repositories.fork`, wait until GitHub makes the fork available, then use `github.branches.create` in the fork.
5. Use `github.contents.put` for one bounded UTF-8 file per commit. Read an existing file first and supply its exact blob `sha` when updating it; omit `sha` only for a new path. Confirm the exact owner, repository, branch, path, commit message, and content change before writing.
6. Fork, branch, and content mutations require `repository.write`, Harness write approval, and commit admission. Do not work around a denied write with issue, pull-request, shell, CLI, or connector access.
7. Treat `403` and `404` as possible OAuth, organization-policy, SSO, user-permission, branch-protection, or repository-visibility boundaries. Explain that distinction without claiming a repository does not exist.

Never ask the user for a token and never place credentials in tool input.
