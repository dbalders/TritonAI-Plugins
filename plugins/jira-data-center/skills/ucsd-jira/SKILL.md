---
name: ucsd-jira
description: Read UC San Diego Jira projects, issues, comments, worklogs, and fields.
---

# UC San Diego Jira

Use these tools only for the UC San Diego Jira Data Center instance at `its-pro.ucsd.edu`. They act
as the signed-in user, so Jira shows only what that person can see.

Start with `jira.projects.list` when the project key is unknown. Use `jira.issues.search` with the
narrowest practical JQL and pagination; search results intentionally omit descriptions and
comments. Use `jira.issues.get`, `jira.comments.list`, or `jira.worklogs.list` only when an exact
issue key is known. Use `jira.fields.list` to interpret field IDs, not to infer that the connected
user can view every field on every issue.

Issues and comments can contain sensitive institutional or personal information. Request only what
the task needs and do not echo excess content. Changing Jira requires the separate **Change UCSD
Jira** ability and its preview tools.
