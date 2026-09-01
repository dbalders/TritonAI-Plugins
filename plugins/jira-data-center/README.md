# UC San Diego Jira

This dependency-free TritonAI plugin provides bounded, read-only access to the UC San Diego Jira
Data Center instance at `https://its-pro.ucsd.edu`. It calls Jira's REST API directly over HTTPS.
TritonAI Harness exposes the reviewed tools through its own MCP surface; the plugin does not use
Atlassian's Cloud MCP service or an OAuth flow.

## Connection

Open the UCSD Jira [Personal Access Tokens page](https://its-pro.ucsd.edu/secure/ViewPersonalAccessTokens.jspa),
sign in if prompted, select **Create token**, give the token a recognizable name such as
`TritonAI Harness`, choose an appropriate expiration, and copy the token before closing the dialog.
Then enable the plugin, select **Open token settings** if you still need the page, paste the token,
and select **Connect**. The token is validated against UCSD Jira before it is stored through the
Harness package-scoped secret store. Jira applies the connected user's existing project and issue
permissions.

The only accepted tenant configuration is `https://its-pro.ucsd.edu`; an omitted `tenantUrl`
defaults to that exact origin. Paths, query strings, credentials, non-HTTPS URLs, lookalike hosts,
and alternate ports are rejected.

## Scope

The first version can read the connected user, list visible projects, search issues with bounded
JQL, read one exact issue, list an issue's comments, and list visible Jira fields. Search results
exclude descriptions and comments; those larger fields require an exact issue key. Responses are
bounded and projected rather than returning arbitrary REST payloads.

The plugin deliberately excludes arbitrary Jira REST calls, attachments, worklogs, dashboards,
filters, agile administration, user search, project administration, and every create, edit,
transition, comment, assignment, link, upload, or delete operation. A later write-capable version
should introduce separately reviewed capabilities and Harness write approval immediately before
each fixed mutation.

References:

- https://developer.atlassian.com/server/jira/platform/rest/v10001/intro/
- https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html

From the repository root, run `pnpm --filter @tritonai/plugin-jira-data-center test` and
`pnpm artifacts:sdk` to test and seal the deterministic artifact.
