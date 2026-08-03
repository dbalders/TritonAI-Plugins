---
name: github-issues
description: Read, triage, create, update, or comment on GitHub issues through TritonAI provider tools. Use read tools first and require enabled issue-write access for mutations.
---

# GitHub issues

Use only TritonAI `github.issues.*` tools. Do not assume `gh` CLI or connector authentication.

Read the exact issue and relevant comments before proposing a mutation. Note that GitHub's issue list and search results may also contain pull requests; records with a `pull_request` field are pull requests.

Before creating, updating, closing, reopening, relabeling, reassigning, or commenting, summarize the exact repository, issue number, and intended change. A write requires the `issues.write` capability plus Harness approval. Do not work around a denied write with another tool.

Use bounded queries and pagination. Do not claim a `404` proves nonexistence when app installation or repository selection could hide the resource.
