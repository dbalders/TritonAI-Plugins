---
name: github-pull-requests
description: Read, create, comment on, or review GitHub pull requests through TritonAI provider tools. Never assume gh CLI authentication or merge access.
---

# GitHub pull requests

Use only TritonAI `github.pulls.*`, `github.issues.comments.list`, and relevant read-only repository tools. Do not invoke `gh`, git, GraphQL, or a separate GitHub connector.

Read the pull request, conversation comments, reviews, and inline review comments as needed before acting. Pull-request creation only connects existing head and base refs; this plugin cannot push a branch or commit.

Before a create, comment, approval, request-changes review, or general review, state the exact repository, pull request or refs, and submitted text. The action requires `pull-requests.write` and Harness approval. This plugin cannot merge, close by deletion, edit branches, or change protection rules.

Keep review claims tied to evidence returned by the provider. Use the Actions skill for CI state.
