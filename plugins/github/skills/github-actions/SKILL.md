---
name: github-actions
description: Inspect GitHub Actions runs, jobs, checks, and commit status through TritonAI provider tools for bounded CI triage.
---

# GitHub Actions triage

Use only TritonAI read-only GitHub tools. Start with `github.actions.runs.list`, inspect an exact run with `github.actions.run.get`, and list its bounded jobs with `github.actions.jobs.list`. Use `github.commits.check-runs.list` and `github.commits.status.get` when a pull request or commit ref is known.

Report conclusion, status, failed job or step names, timestamps, and URLs returned by GitHub. This plugin intentionally cannot download logs or artifacts, rerun or cancel workflows, dispatch workflows, edit workflow files, or mutate check/status records. Say when the bounded metadata is insufficient rather than guessing at a log-level cause.
