---
name: ucsd-jira
description: Read bounded UC San Diego Jira projects, issues, comments, fields, and connected-user metadata.
---

# UC San Diego Jira

Use these tools only for the UC San Diego Jira Data Center instance at `its-pro.ucsd.edu`.

Start with `jira.projects.list` when the project key is unknown. Use `jira.issues.search` with the
narrowest practical JQL and pagination; search results intentionally omit descriptions and
comments. Use `jira.issues.get` or `jira.comments.list` only when an exact issue key is known.
Use `jira.fields.list` to interpret field IDs, not to infer that the connected user can view every
field on every issue.

Issues and comments can contain sensitive institutional or personal information. Request only what
the task needs and do not echo excess content. These tools are read-only and cannot create, edit,
transition, assign, comment on, link, upload to, or delete Jira data, nor can they invoke arbitrary
JQL-free REST endpoints.
