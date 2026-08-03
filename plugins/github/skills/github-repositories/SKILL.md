---
name: github-repositories
description: Find and read GitHub repositories, files, and code through TritonAI provider tools. Use when the user asks to inspect GitHub source or repository metadata without changing it.
---

# GitHub repositories

Use only `github.*` provider tools. Do not assume a separately authenticated `gh` CLI, GitHub connector, shell, or browser session.

1. Use `github.identity.get` when account context matters.
2. Use `github.installations.list`, then `github.repositories.list` with an exact installation ID to enumerate the repositories intentionally granted to the app.
3. Prefer `github.repositories.get` for exact owner/repository metadata and `github.contents.get` for an exact file. The content tool does not list directories and will not return files over one megabyte.
4. Use `github.code.search` only after narrowing to an exact owner and repository. Use `github.repositories.search` only for discovery; confirm the exact repository before subsequent reads.
5. Treat `403` and `404` as possible installation, repository-selection, SSO, user-permission, or app-permission boundaries. Explain that distinction without claiming a repository does not exist.

Never ask the user for a token and never place credentials in tool input.
