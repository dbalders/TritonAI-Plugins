---
name: github-contributions
description: Fork repositories, create branches, commit bounded file changes, and open pull requests through TritonAI provider tools for ordinary contribution flows.
---

# GitHub contributions

Use only TritonAI GitHub provider tools. Do not invoke `gh`, git, GraphQL, a shell, or a separate GitHub connector.

Read the target repository and relevant files before changing anything. Prefer a branch in the original repository when the signed-in user has write permission. If GitHub denies that path, use `github.repositories.fork`, wait until GitHub makes the asynchronous fork available, and continue in the signed-in user's fork.

Create a narrowly named branch with `github.branches.create`. Use `github.contents.put` for one bounded UTF-8 file at a time. Include the current file SHA when updating an existing file; omit it only when creating a new file. After the required commits exist, use `github.pulls.create` to open the pull request against the intended base repository. For a fork, pass the pull head as `owner:branch`.

Before each fork, branch, content, or pull-request mutation, state the exact repository, branch, path, and intended change. Repository mutations require `repository.write`, Harness write approval, and commit admission. Pull-request creation separately requires `pull-requests.write`.

This plugin cannot clone repositories, upload binary files, delete files or branches, create repositories, merge pull requests, rewrite commit history, or manage repository settings. Do not work around a denied mutation through another tool.
