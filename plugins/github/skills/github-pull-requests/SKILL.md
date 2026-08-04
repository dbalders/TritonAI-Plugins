---
name: github-pull-requests
description: Read, prepare branches and commits for, create, comment on, or review GitHub pull requests through TritonAI provider tools. Never assume gh CLI authentication or merge access.
---

# GitHub pull requests

Use only TritonAI `github.pulls.*`, `github.issues.comments.list`, and relevant read-only repository tools. Do not invoke `gh`, git, GraphQL, or a separate GitHub connector.

Read the pull request, conversation comments, reviews, and inline review comments as needed before acting. For a new contribution, use the repository skill's fixed fork, branch, and bounded content-commit tools before creating the pull request. Users with write permission can branch in the target repository; others should fork into their personal account and use the fork's branch as the head.

Before a create, comment, approval, request-changes review, or general review, state the exact repository, pull request or refs, and submitted text. The action requires `pull-requests.write` and Harness approval. Branch and content writes separately require `repository.write`. This plugin cannot merge, close by deletion, delete branches, or change protection rules.

Keep review claims tied to evidence returned by the provider. Use the Actions skill for CI state.
